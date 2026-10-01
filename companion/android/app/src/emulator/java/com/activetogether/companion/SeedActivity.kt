package com.activetogether.companion

import android.os.Bundle
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseRoute
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.units.Length
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.math.cos
import kotlin.math.sin

/**
 * Emulator build only: writes three sample workouts into Health Connect so sync can be tried on an
 * emulator - a run with distance and a GPS route today, a walk with both yesterday, and a yoga
 * session with neither two days ago. Run with: adb shell am start -n <pkg>/com.activetogether.companion.SeedActivity
 */
class SeedActivity : ComponentActivity() {
    private val perms = setOf(
        HealthPermission.getWritePermission(ExerciseSessionRecord::class),
        HealthPermission.getWritePermission(DistanceRecord::class),
        HealthPermission.PERMISSION_WRITE_EXERCISE_ROUTE,
    )
    private lateinit var text: TextView
    private val launcher = registerForActivityResult(PermissionController.createRequestPermissionResultContract()) { if (it.containsAll(perms)) seed() else text.text = "Write permission not granted" }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        text = TextView(this).apply { text = "Seeding..."; textSize = 22f; setPadding(48, 200, 48, 48) }
        setContentView(text)
        lifecycleScope.launch {
            val granted = HealthConnectClient.getOrCreate(this@SeedActivity).permissionController.getGrantedPermissions()
            if (granted.containsAll(perms)) seed() else launcher.launch(perms)
        }
    }

    private fun loop(start: ZonedDateTime, minutes: Long, radiusDeg: Double, lat0: Double, lon0: Double): ExerciseRoute {
        // Health Connect wants every point strictly before the session ends.
        val n = (minutes * 6).toInt() - 1
        return ExerciseRoute((0..n).map { i ->
            val a = i.toDouble() / n * 2 * Math.PI
            ExerciseRoute.Location(
                time = start.plusSeconds(i * 10L).toInstant(),
                latitude = lat0 + radiusDeg * sin(a),
                longitude = lon0 + radiusDeg * 1.6 * cos(a),
                altitude = Length.meters(20.0 + 5 * sin(a * 3)),
            )
        })
    }

    private fun seed() = lifecycleScope.launch {
        val zone = ZoneId.systemDefault()
        val client = HealthConnectClient.getOrCreate(this@SeedActivity)
        fun at(daysAgo: Long, h: Int, m: Int) = ZonedDateTime.of(LocalDate.now().minusDays(daysAgo), LocalTime.of(h, m), zone)
        val runStart = at(0, 7, 0); val runEnd = runStart.plusMinutes(42)
        val walkStart = at(1, 18, 0); val walkEnd = walkStart.plusMinutes(30)
        val yogaStart = at(2, 12, 0); val yogaEnd = yogaStart.plusMinutes(45)
        val off = { z: ZonedDateTime -> z.offset }
        // "--ez runSync true": run the background sync worker once, 20s from now (go home meanwhile),
        // to test it without waiting hours for the periodic schedule.
        if (intent.getBooleanExtra("runSync", false)) {
            androidx.work.WorkManager.getInstance(this@SeedActivity).enqueue(
                androidx.work.OneTimeWorkRequestBuilder<SyncWorker>().setInitialDelay(20, java.util.concurrent.TimeUnit.SECONDS)
                    // As the real periodic work does: background jobs only get network if they ask for it.
                    .setConstraints(androidx.work.Constraints.Builder().setRequiredNetworkType(androidx.work.NetworkType.CONNECTED).build())
                    .build())
            text.text = "Background sync queued for 20s from now"
            return@launch
        }
        // "--ez fresh true": one new 25-minute run ending ten minutes ago, for testing automatic sync.
        if (intent.getBooleanExtra("fresh", false)) {
            val end = ZonedDateTime.now(zone).minusMinutes(10).withSecond(0).withNano(0); val start = end.minusMinutes(25)
            try {
                client.insertRecords(listOf(
                    ExerciseSessionRecord(startTime = start.toInstant(), startZoneOffset = off(start), endTime = end.toInstant(), endZoneOffset = off(end),
                        exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_RUNNING, title = "Fresh run", exerciseRoute = loop(start, 25, 0.003, 51.5033, -0.1196)),
                    DistanceRecord(startTime = start.toInstant(), startZoneOffset = off(start), endTime = end.toInstant(), endZoneOffset = off(end), distance = Length.kilometers(4.1)),
                ))
                text.text = "Seeded a fresh run at ${start.toLocalTime()}"
            } catch (e: Exception) { text.text = "Seeding failed: ${e.message}" }
            return@launch
        }
        try {
            client.insertRecords(listOf(
                ExerciseSessionRecord(startTime = runStart.toInstant(), startZoneOffset = off(runStart), endTime = runEnd.toInstant(), endZoneOffset = off(runEnd),
                    exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_RUNNING, title = "Morning run",
                    exerciseRoute = loop(runStart, 42, 0.0045, 51.5073, -0.1657)),
                DistanceRecord(startTime = runStart.toInstant(), startZoneOffset = off(runStart), endTime = runEnd.toInstant(), endZoneOffset = off(runEnd), distance = Length.kilometers(6.4)),
                ExerciseSessionRecord(startTime = walkStart.toInstant(), startZoneOffset = off(walkStart), endTime = walkEnd.toInstant(), endZoneOffset = off(walkEnd),
                    exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_WALKING, title = "Evening walk",
                    exerciseRoute = loop(walkStart, 30, 0.0025, 51.5226, -0.1546)),
                DistanceRecord(startTime = walkStart.toInstant(), startZoneOffset = off(walkStart), endTime = walkEnd.toInstant(), endZoneOffset = off(walkEnd), distance = Length.kilometers(2.4)),
                ExerciseSessionRecord(startTime = yogaStart.toInstant(), startZoneOffset = off(yogaStart), endTime = yogaEnd.toInstant(), endZoneOffset = off(yogaEnd),
                    exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_YOGA, title = "Yoga"),
            ))
            text.text = "Seeded 3 workouts"
        } catch (e: Exception) {
            text.text = "Seeding failed: ${e.message}"
        }
    }
}
