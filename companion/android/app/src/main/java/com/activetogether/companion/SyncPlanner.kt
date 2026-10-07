package com.activetogether.companion

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.time.LocalDate
import java.util.concurrent.TimeUnit

/** A device workout and every challenge it could go into. */
data class Candidate(
    val workout: DeviceWorkout,
    /** Challenges whose dates include this workout and that I can log into (a team if it needs one). */
    val fits: List<Challenge>,
    /** Of those, the ones it is already in. */
    val alreadyIn: Set<Int>,
) {
    val outstanding: List<Challenge> get() = fits.filter { it.id !in alreadyIn }
}

class SyncPlanner(private val context: Context) {
    private val health = HealthConnectSync(context)

    /** Read every workout in the span of my challenges and match each to the challenges it fits. */
    suspend fun plan(api: ActiveTogetherApi, challenges: List<Challenge>, withRoutes: Boolean): List<Candidate> {
        // Step challenges take daily totals (see [syncSteps]), not workouts.
        val open = challenges.filter { it.target != null && !it.measuresSteps }
        if (open.isEmpty()) return emptyList()
        val from = open.minOf { it.startDate }
        val to = minOf(open.maxOf { it.endDate }, LocalDate.now())
        val workouts = health.readWorkouts(from, to, withRoutes)
        val known = api.syncedIn(workouts.map { it.sourceRef })
        return workouts.map { w ->
            Candidate(w, open.filter { it.contains(w.day) && it.accepts(w.type) }, known[w.sourceRef].orEmpty())
        }.filter { it.fits.isNotEmpty() }
    }

    /**
     * Every day's step total into each step challenge running that day, up to today. A day already
     * sent is updated on the server if the count has grown, so this is safe to run often.
     */
    suspend fun syncSteps(api: ActiveTogetherApi, challenges: List<Challenge>): ImportResult {
        val stepChallenges = challenges.filter { it.measuresSteps && it.target != null && !it.startDate.isAfter(LocalDate.now()) }
        if (stepChallenges.isEmpty()) return ImportResult(0, 0)
        val daily = health.readDailySteps(stepChallenges.minOf { it.startDate }, stepChallenges.maxOf { it.endDate })
        val days = stepChallenges.flatMap { c -> daily.filterKeys { c.contains(it) }.map { (day, n) -> StepDay(c.target!!, day, n) } }
        return api.importSteps(days)
    }

    /**
     * Upload one workout into the chosen challenges - one record per challenge, all in a single
     * request. The route rides on the first record only; the server links the rest to it.
     */
    fun upload(api: ActiveTogetherApi, w: DeviceWorkout, type: String, distanceMeters: Double?, route: List<RoutePoint>?, into: List<Challenge>): ImportResult {
        val records = into.mapNotNull { c -> c.target }.mapIndexed { i, t ->
            HealthRecord(t, type, w.minutes, distanceMeters, w.day.toString(), w.sourceRef, w.startTime, w.endTime, if (i == 0) route else null)
        }
        if (records.isEmpty()) return ImportResult(0, 0)
        return api.importHealth(records)
    }

    /**
     * The no-questions-asked version used by automatic sync: each new workout goes into every
     * challenge it fits and isn't already in, with the type Health Connect gave it. A distance
     * challenge is skipped for a workout with no recorded distance (nobody is there to type one).
     */
    suspend fun autoSync(api: ActiveTogetherApi, prefs: Prefs): SyncCounts {
        val challenges = api.challenges()
        val steps = runCatching { syncSteps(api, challenges) }.getOrDefault(ImportResult(0, 0))
        val candidates = plan(api, challenges, prefs.includeRoutes)
        var workouts = 0
        var entries = 0
        for (c in candidates) {
            val into = c.outstanding.filter { !it.measuresDistance || c.workout.distanceMeters != null }
            if (into.isEmpty()) continue
            val route = (c.workout.route as? RouteState.Available)?.points
            val r = upload(api, c.workout, c.workout.type, c.workout.distanceMeters, route, into)
            if (r.added > 0) { workouts++; entries += r.added }
        }
        return SyncCounts(workouts, entries, steps.added + steps.updated)
    }
}

/** What an automatic sync did: new workouts, the challenge entries they made, and step days added or updated. */
data class SyncCounts(val workouts: Int, val entries: Int, val stepDays: Int) {
    val any: Boolean get() = workouts > 0 || stepDays > 0
    fun summary(): String = listOfNotNull(
        if (workouts > 0) "$workouts workout${if (workouts == 1) "" else "s"} ($entries challenge entr${if (entries == 1) "y" else "ies"})" else null,
        if (stepDays > 0) "steps for $stepDays day${if (stepDays == 1) "" else "s"}" else null,
    ).joinToString(" and ").ifBlank { "nothing new" }
}

/** Background sync, every few hours while automatic sync is on. */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val prefs = Prefs(applicationContext)
        val token = prefs.token ?: return skip("signed out")
        if (!prefs.autoSync) return skip("automatic sync is off")
        val health = HealthConnectSync(applicationContext)
        if (!health.isAvailable()) return skip("Health Connect unavailable")
        val granted = runCatching { health.grantedPermissions() }.getOrDefault(emptySet())
        // Without background access Health Connect refuses reads while the app is closed; the app
        // syncs on opening instead.
        if (!granted.containsAll(health.requiredPermissions) || health.backgroundPermission !in granted) return skip("no background read permission")
        return try {
            val counts = SyncPlanner(applicationContext).autoSync(ActiveTogetherApi(token), prefs)
            Log.i(TAG, "background sync: ${counts.summary()}")
            if (counts.any) {
                val msg = "Synced ${counts.summary()}"
                prefs.lastSyncSummary = "$msg - ${java.time.LocalDateTime.now().withNano(0).toString().replace('T', ' ')}"
                notify(applicationContext, msg)
            }
            Result.success()
        } catch (e: ApiException) {
            Log.w(TAG, "background sync failed: ${e.status} ${e.message}")
            if (e.status == 401) { notify(applicationContext, "Automatic sync stopped: please sign in again"); Result.success() } else Result.retry()
        } catch (e: Exception) {
            Log.w(TAG, "background sync failed", e)
            Result.retry()
        }
    }

    private fun skip(why: String): Result { Log.i(TAG, "background sync skipped: $why"); return Result.success() }

    companion object {
        private const val TAG = "ActiveTogetherSync"
        private const val WORK = "auto-sync"
        private const val CHANNEL = "sync"

        fun schedule(context: Context, hours: Int) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(hours.toLong(), TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.UPDATE, request)
        }

        fun cancel(context: Context) = WorkManager.getInstance(context).cancelUniqueWork(WORK)

        fun notify(context: Context, text: String) {
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
            val nm = context.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL) == null) {
                nm.createNotificationChannel(NotificationChannel(CHANNEL, "Automatic sync", NotificationManager.IMPORTANCE_LOW))
            }
            val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
            val n = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_sync)
                .setContentTitle(if (text.startsWith("Synced")) "Workouts synced" else "Active Together")
                .setContentText(text)
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            NotificationManagerCompat.from(context).notify(1, n)
        }
    }
}
