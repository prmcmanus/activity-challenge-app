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
import com.activetogether.companion.AppRelease
import com.activetogether.companion.BuildConfig
import com.activetogether.companion.inviteCodeFrom
import com.activetogether.companion.Candidate
import com.activetogether.companion.Challenge
import com.activetogether.companion.ChallengeDetail
import com.activetogether.companion.ChallengeFields
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
    /** Full challenge records (invite code, teams, whether I can edit), loaded when a challenge is opened. */
    var details by mutableStateOf<Map<Int, ChallengeDetail>>(emptyMap()); private set
    /** An invite link waiting to be confirmed (kept through signing in). */
    var pendingInvite by mutableStateOf(prefs.pendingInvite); private set
    /** A newer build on the website than this one, if there is. */
    var update by mutableStateOf<AppRelease?>(null); private set

    fun openLink(uri: android.net.Uri?) {
        val code = inviteCodeFrom(uri) ?: return
        pendingInvite = code; prefs.pendingInvite = code
    }
    fun clearInvite() { pendingInvite = null; prefs.pendingInvite = null }

    suspend fun checkForUpdate() {
        // A Play Store build is only ever updated by the Play Store.
        if (!BuildConfig.SELF_UPDATE) return
        // Quietly: a failed check shouldn't put up an error.
        update = runCatching { withContext(Dispatchers.IO) { api().androidRelease() } }.getOrNull()?.takeIf { it.versionCode > BuildConfig.VERSION_CODE }
    }
    suspend fun updateLink(): String? = call { it.androidDownloadLink() }

    /** The tab screens' pull-to-refresh (and the top-bar refresh button) share this. */
    var topRefreshing by mutableStateOf(false); private set

    var review by mutableStateOf<List<ReviewItem>?>(null); private set
    /** Help badge: unread replies on my tickets, plus (admins) tickets waiting for support. */
    var helpBadge by mutableStateOf(0); private set
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
        refreshHelpBadge()
        checkForUpdate()
        // "Sync when the app opens" half of automatic sync, for phones without background access.
        if (prefs.autoSync && challenges.isNotEmpty()) autoSyncNow(quiet = true)
    }

    /** Sign in with a password: [done] gets an error, or (two-step sign-in) the ticket to send with the code. */
    fun signIn(email: String, password: String, done: (error: String?, ticket: String?) -> Unit) = viewModelScope.launch {
        try {
            val step = withContext(Dispatchers.IO) { ActiveTogetherApi().login(email.trim(), password) }
            prefs.email = email.trim()
            if (step.ticket != null) { done(null, step.ticket); return@launch }
            signedInWith(step.token!!)
            done(null, null)
        } catch (e: Exception) {
            done(e.message ?: "Sign in failed", null)
        }
    }

    /** Create an account in the app, then signed in as it. An invite link that brought them here is asked about next. */
    fun register(name: String, email: String, password: String, inviteCode: String?, done: (String?) -> Unit) = viewModelScope.launch {
        try {
            val token = withContext(Dispatchers.IO) { ActiveTogetherApi().register(name.trim(), email.trim(), password, inviteCode) }
            prefs.email = email.trim()
            signedInWith(token)
            done(null)
        } catch (e: Exception) {
            done(e.message ?: "Couldn't create the account")
        }
    }

    /** Sign in with Google (or Apple): [done] gets an error, the two-step ticket, and whether an invite code is needed. */
    fun socialSignIn(provider: String, credential: String, inviteCode: String?, done: (error: String?, ticket: String?, inviteNeeded: Boolean) -> Unit) = viewModelScope.launch {
        try {
            val step = withContext(Dispatchers.IO) { ActiveTogetherApi().socialLogin(provider, credential, inviteCode) }
            if (step.ticket != null) { done(null, step.ticket, false); return@launch }
            signedInWith(step.token!!)
            done(null, null, false)
        } catch (e: ApiException) {
            done(e.message, null, e.body?.optBoolean("inviteRequired") == true)
        } catch (e: Exception) {
            done(e.message ?: "Sign in failed", null, false)
        }
    }

    /** The second step of two-step sign-in. */
    fun signInCode(ticket: String, code: String, done: (String?) -> Unit) = viewModelScope.launch {
        try {
            val token = withContext(Dispatchers.IO) { ActiveTogetherApi().loginCode(ticket, code.trim()) }
            signedInWith(token)
            done(null)
        } catch (e: Exception) {
            done(e.message ?: "Sign in failed")
        }
    }

    private fun signedInWith(token: String) {
        prefs.token = token
        signedIn = true
        refreshAll()
    }

    fun signOut() = viewModelScope.launch {
        val api = api()
        runCatching { withContext(Dispatchers.IO) { api.logout() } }
        forceSignOut(null)
    }

    /** Delete my account; on success I'm signed out with a note saying so. */
    suspend fun deleteAccount(password: String): Boolean {
        call { it.deleteAccount(password) } ?: return false
        forceSignOut("Your account has been deleted")
        return true
    }

    private fun forceSignOut(msg: String?) {
        prefs.signOut()
        SyncWorker.cancel(getApplication())
        signedIn = false
        me = null; challenges = emptyList(); activities = emptyList(); review = null; details = emptyMap()
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

    suspend fun refreshMe() { call { it.me() }?.let { me = it } }

    /**
     * Pull-to-refresh on the top-level lists. The screens hold their own "refreshing" flag around
     * this: the shared loading flags flip at the wrong moments (or are gated on an empty list), which
     * left the indicator stuck or never shown.
     */
    suspend fun refreshTopLevel() {
        call { it.me() }?.let { me = it }
        call { it.challenges() }?.let { challenges = it }
        refreshActivities()
        refreshHelpBadge()
        checkForUpdate()
    }

    /** Pull-to-refresh / refresh button on the tab screens. Says when it's done, so a refresh that changed nothing still visibly happened. */
    fun refreshTop() = viewModelScope.launch {
        if (topRefreshing) return@launch
        topRefreshing = true
        val before = message
        refreshTopLevel()
        topRefreshing = false
        if (message == before) message = "Up to date"
    }

    // --- challenges: open, create, edit, join -------------------------------------------------

    suspend fun loadDetail(id: Int) { call { it.challengeDetail(id) }?.let { details = details + (id to it) } }

    /** Creates the challenge and, for a team challenge, an optional first team. Returns the new id. */
    suspend fun createChallenge(f: ChallengeFields, firstTeam: String): Int? {
        val (id, code) = call { it.createChallenge(f) } ?: return null
        if (!f.individual && firstTeam.isNotBlank()) call { it.createTeam(id, firstTeam.trim()) }
        call { it.challenges() }?.let { challenges = it }
        loadDetail(id)
        message = "Challenge created. Invite code: $code"
        return id
    }

    suspend fun updateChallenge(id: Int, f: ChallengeFields): Boolean {
        call { it.updateChallenge(id, f) } ?: return false
        call { it.challenges() }?.let { challenges = it }
        loadDetail(id)
        leaderboards.value = leaderboards.value - id
        message = "Challenge saved"
        return true
    }

    suspend fun deleteChallenge(id: Int): Boolean {
        call { it.deleteChallenge(id) } ?: return false
        challenges = challenges.filterNot { it.id == id }
        details = details - id
        call { it.challenges() }?.let { challenges = it }
        refreshActivities()
        message = "Challenge deleted"
        return true
    }

    /** Join with an invite code; returns the challenge id to open. */
    suspend fun join(code: String): Int? {
        val (id, name) = call { it.join(code) } ?: return null
        call { it.challenges() }?.let { challenges = it }
        loadDetail(id)
        message = "Joined ${name.ifBlank { "the challenge" }}"
        return id
    }

    suspend fun createTeam(challengeId: Int, name: String): Boolean {
        call { it.createTeam(challengeId, name.trim()) } ?: return false
        afterTeamChange(challengeId); message = "Team created - you're in it"; return true
    }

    suspend fun joinTeam(challengeId: Int, teamId: Int) {
        call { it.joinTeam(teamId) } ?: return
        afterTeamChange(challengeId); message = "Joined the team"
    }

    suspend fun leaveTeam(challengeId: Int, teamId: Int) {
        call { it.leaveTeam(teamId) } ?: return
        afterTeamChange(challengeId); message = "You've left the team"
    }

    /** Leave a challenge; returns true once I'm out, so the screen can go back. */
    suspend fun leaveChallenge(id: Int): Boolean {
        call { it.leaveChallenge(id) } ?: return false
        challenges = challenges.filterNot { it.id == id }
        details = details - id
        leaderboards.value = leaderboards.value - id
        call { it.challenges() }?.let { challenges = it }
        refreshActivities()
        message = "You've left the challenge"
        return true
    }

    private suspend fun afterTeamChange(challengeId: Int) {
        call { it.challenges() }?.let { challenges = it }
        loadDetail(challengeId)
        call { it.leaderboard(challengeId) }?.let { leaderboards.value = leaderboards.value + (challengeId to it) }
    }

    suspend fun refreshHelpBadge() {
        call { it.ticketBadge() }?.let { (mine, admin) -> helpBadge = mine + if (me?.isAdmin == true) admin else 0 }
    }

    /** Pull-to-refresh on a challenge: its numbers and leaderboard. */
    suspend fun refreshChallenge(challengeId: Int) {
        call { it.challenges() }?.let { challenges = it }
        loadDetail(challengeId)
        call { it.leaderboard(challengeId) }?.let { leaderboards.value = leaderboards.value + (challengeId to it) }
    }

    suspend fun refreshActivities() {
        call { it.myActivities(0, maxOf(30, activities.size)) }?.let { (list, more) -> activities = list; moreActivities = more }
    }

    /**
     * Edit a workout everywhere it's logged: one PATCH per challenge entry. An entry the change
     * doesn't fit (a date outside that challenge, no distance for a distance challenge) is left as
     * it was and named in the message; the rest are saved.
     */
    suspend fun editWorkout(entries: List<MyActivity>, type: String, date: java.time.LocalDate, minutes: Int?, distance: Double?, unit: String,
                            start: String?, end: String?, comment: String): Boolean {
        val failed = mutableListOf<String>()
        for (e in entries) {
            try {
                withContext(Dispatchers.IO) { api().editActivity(e.id, type, date, minutes, distance, unit, start, end, comment) }
            } catch (ex: ApiException) {
                if (ex.status == 401) { forceSignOut("Your session has expired. Please sign in again."); return false }
                failed += "${e.challengeName}: ${ex.message}"
            } catch (ex: Exception) {
                failed += "${e.challengeName}: ${ex.message}"
            }
        }
        afterChange()
        message = if (failed.isEmpty()) "Activity updated" else "Not changed in " + failed.joinToString("; ")
        return failed.size < entries.size
    }

    // --- sync ------------------------------------------------------------------------------

    fun startReview() = viewModelScope.launch {
        syncBusy = true
        syncStatus = "Reading Health Connect..."
        try {
            val fresh = call { it.challenges() } ?: return@launch
            challenges = fresh
            val planner = SyncPlanner(getApplication())
            // Step counts need no review: send them straight away, then review workouts.
            val steps = withContext(Dispatchers.IO) { runCatching { planner.syncSteps(api(), fresh) }.getOrNull() }
            val stepDays = steps?.let { it.added + it.updated } ?: 0
            if (stepDays > 0) call { it.challenges() }?.let { challenges = it }
            val stepNote = if (stepDays > 0) "Updated steps for $stepDays day${if (stepDays == 1) "" else "s"}. " else ""
            if (stepDays > 0) message = stepNote.trim()
            val candidates = withContext(Dispatchers.IO) { planner.plan(api(), fresh, prefs.includeRoutes) }
            review = candidates.map { c ->
                val unit = c.outstanding.firstOrNull { it.measuresDistance }?.distanceUnit ?: c.fits.firstOrNull { it.measuresDistance }?.distanceUnit ?: prefs.preferredUnit
                ReviewItem(c, unit)
            }
            syncStatus = stepNote + if (candidates.isEmpty()) "No workouts in Health Connect fall within your challenges' dates." else ""
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
            val counts = withContext(Dispatchers.IO) { SyncPlanner(getApplication()).autoSync(api(), prefs) }
            if (counts.any) {
                syncStatus = "Synced ${counts.summary()}."
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
