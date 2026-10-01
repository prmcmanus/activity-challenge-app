package com.activetogether.companion

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.feature.ExperimentalFeatureAvailabilityApi
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseRoute
import androidx.health.connect.client.records.ExerciseRouteResult
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Whether a workout's GPS route can be read. */
sealed interface RouteState {
    data class Available(val points: List<RoutePoint>) : RouteState
    /** Recorded by another app: Health Connect asks the person once per workout before sharing it. */
    data object NeedsConsent : RouteState
    data object None : RouteState
}

/** One workout as Health Connect has it, before it is matched to any challenge. */
data class DeviceWorkout(
    val sessionId: String,
    val sourceRef: String,
    val type: String,
    val start: Instant,
    val end: Instant,
    val minutes: Long,
    val distanceMeters: Double?,
    val route: RouteState,
    val sourceApp: String,
) {
    private val zone get() = ZoneId.systemDefault()
    val day: LocalDate get() = start.atZone(zone).toLocalDate()
    val startTime: String get() = start.atZone(zone).format(HHMM)
    val endTime: String get() = end.atZone(zone).format(HHMM)

    companion object {
        private val HHMM = DateTimeFormatter.ofPattern("HH:mm")
    }
}

fun ExerciseRoute.toPoints(): List<RoutePoint> =
    route.map { RoutePoint(it.latitude, it.longitude, it.time.toEpochMilli(), it.altitude?.inMeters) }

class HealthConnectSync(private val context: Context) {
    // Exercise sessions are required. Distance is optional: without it, sessions still sync with
    // their minutes, and only distance challenges skip them.
    val requiredPermissions = setOf(HealthPermission.getReadPermission(ExerciseSessionRecord::class))
    val distancePermission = HealthPermission.getReadPermission(DistanceRecord::class)
    val backgroundPermission = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
    val historyPermission = HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY
    val permissions = requiredPermissions + distancePermission

    fun status(): Int = HealthConnectClient.getSdkStatus(context)
    fun isAvailable(): Boolean = status() == HealthConnectClient.SDK_AVAILABLE
    private fun client() = HealthConnectClient.getOrCreate(context)

    suspend fun grantedPermissions(): Set<String> = client().permissionController.getGrantedPermissions()

    @OptIn(ExperimentalFeatureAvailabilityApi::class)
    fun backgroundReadSupported(): Boolean = isAvailable() &&
        client().features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE

    @OptIn(ExperimentalFeatureAvailabilityApi::class)
    fun historyReadSupported(): Boolean = isAvailable() &&
        client().features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY) == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE

    /**
     * Workouts that started between [from] and [to] (inclusive, local days). Health Connect shares
     * only the 30 days before permission was granted unless the history permission is also held.
     */
    suspend fun readWorkouts(from: LocalDate, to: LocalDate, withRoutes: Boolean): List<DeviceWorkout> {
        val client = client()
        val granted = grantedPermissions()
        val canReadDistance = distancePermission in granted
        val zone = ZoneId.systemDefault()
        val now = Instant.now()
        val earliest = if (historyPermission in granted) Instant.EPOCH else now.minus(Duration.ofDays(30))
        val start = maxOf(from.atStartOfDay(zone).toInstant(), earliest)
        val end = minOf(to.plusDays(1).atStartOfDay(zone).toInstant(), now)
        if (!start.isBefore(end)) return emptyList()

        val sessions = mutableListOf<ExerciseSessionRecord>()
        var pageToken: String? = null
        do {
            val page = client.readRecords(ReadRecordsRequest(
                recordType = ExerciseSessionRecord::class,
                timeRangeFilter = TimeRangeFilter.between(start, end),
                pageToken = pageToken,
            ))
            sessions += page.records
            pageToken = page.pageToken
        } while (pageToken != null && sessions.size < 1000)

        return sessions.mapNotNull { s ->
            val minutes = Duration.between(s.startTime, s.endTime).toMinutes()
            if (minutes <= 0) return@mapNotNull null
            val route = when (val r = s.exerciseRouteResult) {
                is ExerciseRouteResult.Data -> if (withRoutes && r.exerciseRoute.route.size >= 2) RouteState.Available(r.exerciseRoute.toPoints()) else RouteState.None
                is ExerciseRouteResult.ConsentRequired -> if (withRoutes) RouteState.NeedsConsent else RouteState.None
                else -> RouteState.None
            }
            DeviceWorkout(
                sessionId = s.metadata.id,
                sourceRef = s.metadata.id.ifBlank { "${s.startTime}-${s.endTime}-${s.exerciseType}" },
                type = exerciseLabel(s.exerciseType),
                start = s.startTime,
                end = s.endTime,
                minutes = minutes,
                distanceMeters = if (canReadDistance) distanceDuring(client, s) else null,
                route = route,
                sourceApp = s.metadata.dataOrigin.packageName,
            )
        }.sortedByDescending { it.start }
    }

    /**
     * Sessions don't carry a distance themselves - it is recorded as separate DistanceRecords over
     * the same period. The aggregate de-duplicates overlapping sources (a watch and a phone both
     * counting the same walk), so it is tried first. Some apps' records don't come through it
     * (seen with a workout entered by hand in Google Fit), so the raw records are the fallback:
     * per source app, each record's share that falls inside the session, preferring the app that
     * wrote the session and otherwise taking the single largest source - never adding sources
     * together, which would count the same walk twice. Null when nothing was recorded.
     */
    private suspend fun distanceDuring(client: HealthConnectClient, session: ExerciseSessionRecord): Double? {
        val range = TimeRangeFilter.between(session.startTime, session.endTime)
        val aggregated = runCatching {
            client.aggregate(AggregateRequest(metrics = setOf(DistanceRecord.DISTANCE_TOTAL), timeRangeFilter = range))[DistanceRecord.DISTANCE_TOTAL]?.inMeters
        }.getOrNull()
        if (aggregated != null && aggregated > 0) return aggregated

        val raw = runCatching {
            client.readRecords(ReadRecordsRequest(recordType = DistanceRecord::class, timeRangeFilter = range)).records
        }.getOrDefault(emptyList())
        if (raw.isEmpty()) return null
        val byOrigin = raw.groupBy { it.metadata.dataOrigin.packageName }.mapValues { (_, records) ->
            records.sumOf { r -> r.distance.inMeters * overlapShare(r.startTime, r.endTime, session.startTime, session.endTime) }
        }
        val meters = byOrigin[session.metadata.dataOrigin.packageName]?.takeIf { it > 0 } ?: byOrigin.values.maxOrNull()
        return meters?.takeIf { it > 0 }
    }

    /** The fraction of [rStart, rEnd] inside [sStart, sEnd]; a zero-length record counts whole if inside. */
    private fun overlapShare(rStart: Instant, rEnd: Instant, sStart: Instant, sEnd: Instant): Double {
        val total = Duration.between(rStart, rEnd).toMillis()
        if (total <= 0) return if (!rStart.isBefore(sStart) && !rStart.isAfter(sEnd)) 1.0 else 0.0
        val inside = Duration.between(maxOf(rStart, sStart), minOf(rEnd, sEnd)).toMillis()
        return (inside.toDouble() / total).coerceIn(0.0, 1.0)
    }

    /** Short label for the common types; anything else uploads as "Exercise". */
    private fun exerciseLabel(type: Int): String = when (type) {
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "Walking"
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING, ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL -> "Running"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING, ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY -> "Cycling"
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "Hiking"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER, ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL -> "Swimming"
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING, ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE -> "Rowing"
        ExerciseSessionRecord.EXERCISE_TYPE_WHEELCHAIR -> "Wheelchair"
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA -> "Yoga"
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING -> "HIIT"
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL -> "Elliptical"
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING, ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING -> "Strength training"
        else -> "Exercise"
    }
}

/** Activity types offered when logging or reviewing; a workout's own label is added if not listed. */
val ACTIVITY_TYPES = listOf("Walking", "Running", "Cycling", "Swimming", "Hiking", "Rowing", "Wheelchair",
    "Strength training", "Yoga", "HIIT", "Elliptical", "Exercise")

data class DistanceUnit(val code: String, val label: String, val meters: Double)
val DISTANCE_UNITS = listOf(DistanceUnit("mi", "miles", 1609.344), DistanceUnit("km", "km", 1000.0))
fun unitMeters(code: String) = if (code == "km") 1000.0 else 1609.344
fun unitLabel(code: String) = if (code == "km") "km" else "mi"
