package com.activetogether.companion.ui

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.activetogether.companion.ActiveTogetherApi
import com.activetogether.companion.ApiException
import com.activetogether.companion.Candidate
import com.activetogether.companion.Challenge
import com.activetogether.companion.HealthConnectSync
import com.activetogether.companion.Leaderboard
import com.activetogether.companion.Me
import com.activetogether.companion.MyActivity
import com.activetogether.companion.Prefs
import com.activetogether.companion.RoutePoint
import com.activetogether.companion.RouteState
import com.activetogether.companion.SyncPlanner
import com.activetogether.companion.SyncWorker
import com.activetogether.companion.unitMeters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.LocalDateTime

/** One workout in the sync review, with what the person has chosen for it. */
class ReviewItem(val candidate: Candidate, defaultUnit: String) {
    private val w = candidate.workout
    var include by mutableStateOf(candidate.outstanding.isNotEmpty())
    var type by mutableStateOf(w.type)
    var unit by mutableStateOf(defaultUnit)
    var distanceText by mutableStateOf(w.distanceMeters?.let { String.format(java.util.Locale.US, "%.2f", it / unitMeters(defaultUnit)) } ?: "")
    /** True once the person has typed a distance, so switching unit no longer converts it. */
    var distanceTyped by mutableStateOf(false)
    /** Challenge ids to send into: every outstanding one it fits - except distance challenges while
     *  there is no distance, which are added as soon as one is typed (see [distanceEdited]). */
    val into = mutableStateListOf<Int>().apply { addAll(candidate.outstanding.filter { !it.measuresDistance || w.distanceMeters != null }.map { it.id }) }
    private var distanceChallengesOffered = w.distanceMeters != null
    var route by mutableStateOf(w.route)

    fun distanceEdited(text: String) {
        distanceText = text; distanceTyped = true
        if (!distanceChallengesOffered && distanceMeters() != null) {
            distanceChallengesOffered = true
            candidate.outstanding.filter { it.measuresDistance && it.id !in into }.forEach { into.add(it.id) }
        }
    }
    fun distanceMeters(): Double? = distanceText.trim().replace(',', '.').toDoubleOrNull()?.takeIf { it > 0 }?.times(unitMeters(unit))
    fun switchUnit(u: String) {
        if (!distanceTyped) w.distanceMeters?.let { distanceText = String.format(java.util.Locale.US, "%.2f", it / unitMeters(u)) }
        unit = u
    }
}

class AppViewModel(app: Application) : AndroidViewModel(app) {
    val prefs = Prefs(app)
    val health = HealthConnectSync(app)

    var signedIn by mutableStateOf(prefs.token != null); private set
    var me by mutableStateOf<Me?>(null); private set
    var challenges by mutableStateOf<List<Challenge>>(emptyList()); private set
    var loadingChallenges by mutableStateOf(false); private set
    var message by mutableStateOf<String?>(null)

    var activities by mutableStateOf<List<MyActivity>>(emptyList()); private set
    var moreActivities by mutableStateOf(false); private set
    var loadingActivities by mutableStateOf(false); private set

    val leaderboards = mutableStateOf<Map<Int, Leaderboard>>(emptyMap())

    var review by mutableStateOf<List<ReviewItem>?>(null); private set
    var syncBusy by mutableStateOf(false); private set
    var syncStatus by mutableStateOf(prefs.lastSyncSummary); private set

    fun api() = ActiveTogetherApi(prefs.token)

    /** Run a server call off the main thread; an expired session signs out, anything else becomes a message. */
    suspend fun <T> call(block: (ActiveTogetherApi) -> T): T? = try {
        withContext(Dispatchers.IO) { block(api()) }
    } catch (e: ApiException) {
        if (e.status == 401) { forceSignOut("Your session has expired. Please sign in again."); null } else { message = e.message; null }
    } catch (e: Exception) {
        message = "Couldn't reach Active Together: ${e.message ?: e.javaClass.simpleName}"; null
    }

    init { if (signedIn) refreshAll() }

    fun refreshAll() = viewModelScope.launch {
        loadingChallenges = true
        call { it.me() }?.let { me = it }
        call { it.challenges() }?.let { challenges = it }
        loadingChallenges = false
        loadActivities(reset = true)
        // "Sync when the app opens" half of automatic sync, for phones without background access.
        if (prefs.autoSync && challenges.isNotEmpty()) autoSyncNow(quiet = true)
    }

    fun signIn(email: String, password: String, done: (String?) -> Unit) = viewModelScope.launch {
        try {
            val token = withContext(Dispatchers.IO) { ActiveTogetherApi().login(email.trim(), password) }
            prefs.token = token
            prefs.email = email.trim()
            signedIn = true
            done(null)
            refreshAll()
        } catch (e: Exception) {
            done(e.message ?: "Sign in failed")
        }
    }

    fun signOut() = viewModelScope.launch {
        val api = api()
        runCatching { withContext(Dispatchers.IO) { api.logout() } }
        forceSignOut(null)
    }

    private fun forceSignOut(msg: String?) {
        prefs.signOut()
        SyncWorker.cancel(getApplication())
        signedIn = false
        me = null; challenges = emptyList(); activities = emptyList(); review = null
        message = msg
    }

    fun loadActivities(reset: Boolean) = viewModelScope.launch {
        if (loadingActivities) return@launch
        loadingActivities = true
        call { it.myActivities(if (reset) 0 else activities.size) }?.let { (list, more) ->
            activities = if (reset) list else activities + list
            moreActivities = more
        }
        loadingActivities = false
    }

    fun loadLeaderboard(challengeId: Int) = viewModelScope.launch {
        call { it.leaderboard(challengeId) }?.let { leaderboards.value = leaderboards.value + (challengeId to it) }
    }

    fun deleteActivity(a: MyActivity, done: () -> Unit) = viewModelScope.launch {
        if (call { it.deleteActivity(a.id) } != null) {
            activities = activities.filterNot { it.id == a.id }
            message = "Activity deleted"
            call { it.challenges() }?.let { challenges = it }
            done()
        }
    }

    suspend fun route(activityId: Int): List<RoutePoint>? = call { it.route(activityId) }

    fun afterChange() = viewModelScope.launch {
        call { it.challenges() }?.let { challenges = it }
        loadActivities(reset = true)
        leaderboards.value = emptyMap()
    }

    fun updateMe(m: Me) { me = m }

    // --- sync ------------------------------------------------------------------------------

    fun startReview() = viewModelScope.launch {
        syncBusy = true
        syncStatus = "Reading Health Connect..."
        try {
            val fresh = call { it.challenges() } ?: return@launch
            challenges = fresh
            val planner = SyncPlanner(getApplication())
            val candidates = withContext(Dispatchers.IO) { planner.plan(api(), fresh, prefs.includeRoutes) }
            review = candidates.map { c ->
                val unit = c.outstanding.firstOrNull { it.measuresDistance }?.distanceUnit ?: c.fits.firstOrNull { it.measuresDistance }?.distanceUnit ?: prefs.preferredUnit
                ReviewItem(c, unit)
            }
            syncStatus = if (candidates.isEmpty()) "No workouts in Health Connect fall within your challenges' dates." else ""
        } catch (e: ApiException) {
            if (e.status == 401) forceSignOut("Your session has expired. Please sign in again.") else syncStatus = "Sync failed: ${e.message}"
        } catch (e: SecurityException) {
            syncStatus = "Health Connect permission is needed - tap \"Allow access\" above."
        } catch (e: Exception) {
            syncStatus = "Couldn't read workouts: ${e.message}"
        } finally {
            syncBusy = false
        }
    }

    fun cancelReview() { review = null; syncStatus = "Sync cancelled. Nothing was uploaded." }

    fun setConsentedRoute(item: ReviewItem, points: List<RoutePoint>?) {
        item.route = if (points != null && points.size >= 2) RouteState.Available(points) else RouteState.None
    }

    fun uploadReview() = viewModelScope.launch {
        val items = review ?: return@launch
        syncBusy = true
        var workouts = 0; var entries = 0; var skippedNoDistance = 0
        val planner = SyncPlanner(getApplication())
        try {
            for (item in items.filter { it.include && it.into.isNotEmpty() }) {
                val chosen = item.candidate.fits.filter { it.id in item.into }
                val distance = item.distanceMeters()
                val into = chosen.filter { !it.measuresDistance || distance != null }
                skippedNoDistance += chosen.size - into.size
                if (into.isEmpty()) continue
                val route = (item.route as? RouteState.Available)?.points
                val r = withContext(Dispatchers.IO) { planner.upload(api(), item.candidate.workout, item.type, distance, route, into) }
                if (r.added > 0) { workouts++; entries += r.added }
            }
            syncStatus = "Synced $workouts workout${if (workouts == 1) "" else "s"} into $entries challenge entr${if (entries == 1) "y" else "ies"}." +
                if (skippedNoDistance > 0) " $skippedNoDistance distance-challenge entr${if (skippedNoDistance == 1) "y was" else "ies were"} left out for having no distance." else ""
            prefs.lastSyncSummary = "$syncStatus - ${LocalDateTime.now().withNano(0).toString().replace('T', ' ')}"
            review = null
            afterChange()
        } catch (e: ApiException) {
            if (e.status == 401) forceSignOut("Your session has expired. Please sign in again.") else syncStatus = "Upload failed: ${e.message}"
        } catch (e: Exception) {
            syncStatus = "Upload failed: ${e.message}"
        } finally {
            syncBusy = false
        }
    }

    /** Automatic sync, run now - on opening the app, or from the settings switch. */
    fun autoSyncNow(quiet: Boolean = false) = viewModelScope.launch {
        if (syncBusy || !health.isAvailable()) return@launch
        val granted = runCatching { health.grantedPermissions() }.getOrDefault(emptySet())
        if (!granted.containsAll(health.requiredPermissions)) return@launch
        syncBusy = true
        try {
            val (workouts, entries) = withContext(Dispatchers.IO) { SyncPlanner(getApplication()).autoSync(api(), prefs) }
            if (workouts > 0) {
                syncStatus = "Synced $workouts new workout${if (workouts == 1) "" else "s"} ($entries challenge entr${if (entries == 1) "y" else "ies"})."
                prefs.lastSyncSummary = "$syncStatus - ${LocalDateTime.now().withNano(0).toString().replace('T', ' ')}"
                afterChange()
            } else if (!quiet) syncStatus = "Nothing new to sync."
        } catch (e: Exception) {
            if (!quiet) syncStatus = "Automatic sync failed: ${e.message}"
        } finally {
            syncBusy = false
        }
    }

    fun setAutoSync(on: Boolean, hours: Int = prefs.autoSyncHours) {
        prefs.autoSync = on
        prefs.autoSyncHours = hours
        if (on) SyncWorker.schedule(getApplication(), hours) else SyncWorker.cancel(getApplication())
    }
}
