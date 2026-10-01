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

    suspend fun readExerciseSessions(teamId: Int?, challengeId: Int): List<HealthRecord> {
        val client = HealthConnectClient.getOrCreate(context)
        val canReadDistance = grantedPermissions().contains(distancePermission)
        val end = Instant.now()
        val start = end.minus(Duration.ofDays(30))
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
            val zonedStart = record.startTime.atZone(ZoneId.systemDefault())
            val zonedEnd = record.endTime.atZone(ZoneId.systemDefault())
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
        }
    }

    /**
     * Sessions don't carry a distance themselves - it is recorded as separate DistanceRecords over
     * the same period. The aggregate de-duplicates overlapping sources (a watch and a phone both
     * counting the same walk), which summing raw records would not. Null when nothing was recorded.
     */
    private suspend fun distanceDuring(client: HealthConnectClient, session: ExerciseSessionRecord): Double? {
        val result = client.aggregate(
            AggregateRequest(
                metrics = setOf(DistanceRecord.DISTANCE_TOTAL),
                timeRangeFilter = TimeRangeFilter.between(session.startTime, session.endTime),
            ),
        )
        val meters = result[DistanceRecord.DISTANCE_TOTAL]?.inMeters ?: return null
        return meters.takeIf { it > 0 }
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
