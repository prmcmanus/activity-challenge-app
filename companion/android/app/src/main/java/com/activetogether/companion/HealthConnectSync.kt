package com.activetogether.companion

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

class HealthConnectSync(private val context: Context) {
    // Exercise sessions are required. Distance is optional: without it, sessions still sync with
    // their minutes, and only distance challenges skip them (the server reports those as skipped).
    val requiredPermissions = setOf(HealthPermission.getReadPermission(ExerciseSessionRecord::class))
    val distancePermission = HealthPermission.getReadPermission(DistanceRecord::class)
    val permissions = requiredPermissions + distancePermission

    fun isAvailable(): Boolean =
        HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE

    suspend fun grantedPermissions(): Set<String> =
        HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()

    /**
     * Sessions that started while the challenge was running (its start date to the end of its end
     * date, in this phone's time zone), and no further back than 30 days - Health Connect only
     * gives an app 30 days of history before its permission was granted.
     */
    suspend fun readExerciseSessions(option: TeamOption): List<HealthRecord> {
        val client = HealthConnectClient.getOrCreate(context)
        val canReadDistance = grantedPermissions().contains(distancePermission)
        val zone = ZoneId.systemDefault()
        val now = Instant.now()
        val start = maxOf(option.startDate.atStartOfDay(zone).toInstant(), now.minus(Duration.ofDays(30)))
        val end = minOf(option.endDate.plusDays(1).atStartOfDay(zone).toInstant(), now)
        if (!start.isBefore(end)) return emptyList()
        val teamId = option.teamId
        val challengeId = option.challengeId
        val response = client.readRecords(
            ReadRecordsRequest(
                recordType = ExerciseSessionRecord::class,
                timeRangeFilter = TimeRangeFilter.between(start, end),
            ),
        )

        val timeFormatter = DateTimeFormatter.ofPattern("HH:mm")
        return response.records.mapNotNull { record ->
            val minutes = Duration.between(record.startTime, record.endTime).toMinutes()
            if (minutes <= 0) return@mapNotNull null
            val zonedStart = record.startTime.atZone(zone)
            val zonedEnd = record.endTime.atZone(zone)
            val day = zonedStart.toLocalDate()
            if (day.isBefore(option.startDate) || day.isAfter(option.endDate)) return@mapNotNull null
            HealthRecord(
                teamId = teamId,
                challengeId = challengeId,
                activityType = exerciseLabel(record.exerciseType),
                minutes = minutes,
                distanceMeters = if (canReadDistance) distanceDuring(client, record) else null,
                activityDate = zonedStart.toLocalDate().toString(),
                sourceRef = record.metadata.id.ifBlank { "${record.startTime}-${record.endTime}-${record.exerciseType}" },
                // Only meaningful when the session doesn't cross midnight in the local zone - the
                // server treats an inconsistent pair as "no times" rather than rejecting the sync.
                startTime = zonedStart.format(timeFormatter),
                endTime = zonedEnd.format(timeFormatter),
            )
        }.sortedByDescending { it.activityDate + it.startTime }
    }

    suspend fun canReadDistance(): Boolean = grantedPermissions().contains(distancePermission)

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

    /** Short label for the common types; anything else uploads as "Exercise", as before. */
    private fun exerciseLabel(type: Int): String = when (type) {
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "Walking"
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING, ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL -> "Running"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING, ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY -> "Cycling"
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "Hiking"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER, ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL -> "Swimming"
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING, ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE -> "Rowing"
        ExerciseSessionRecord.EXERCISE_TYPE_WHEELCHAIR -> "Wheelchair"
        else -> "Exercise"
    }
}
