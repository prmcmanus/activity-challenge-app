package com.activetogether.companion

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

class HealthConnectSync(private val context: Context) {
    val permissions = setOf(HealthPermission.getReadPermission(ExerciseSessionRecord::class))

    fun isAvailable(): Boolean =
        HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE

    suspend fun hasPermissions(): Boolean {
        val granted = HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()
        return granted.containsAll(permissions)
    }

    suspend fun readExerciseSessions(teamId: Int, challengeId: Int): List<HealthRecord> {
        val client = HealthConnectClient.getOrCreate(context)
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
                activityType = "Exercise",
                minutes = minutes,
                activityDate = zonedStart.toLocalDate().toString(),
                sourceRef = record.metadata.id.ifBlank { "${record.startTime}-${record.endTime}-${record.exerciseType}" },
                // Only meaningful when the session doesn't cross midnight in the local zone - the
                // server treats an inconsistent pair as "no times" rather than rejecting the sync.
                startTime = zonedStart.format(timeFormatter),
                endTime = zonedEnd.format(timeFormatter),
            )
        }
    }
}
