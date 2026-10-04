package com.activetogether.companion

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate

/** The one server this app talks to. */
const val SERVER_URL = BuildConfig.SERVER_URL

/** Who can see what on my profile: "private" (name, photo), "summary" (+ totals, rank), "full" (+ recent activity). */
data class Me(val id: Int, val name: String, val email: String, val avatarUrl: String?, val bio: String? = null, val sharing: String = "summary",
              val role: String = "member") {
    val isAdmin: Boolean get() = role == "global_admin"
}

/** Help & support. type: bug | feature | question; status: new | in_progress | planned | done | declined. */
data class Ticket(val id: Int, val type: String, val title: String, val description: String, val status: String, val resolution: String?,
    val imageUrl: String?, val clientInfo: String?, val createdAt: String, val updatedAt: String, val reporterName: String, val reporterEmail: String?,
    val commentCount: Int, val unread: Boolean, val mine: Boolean)
data class TicketComment(val id: Int, val body: String, val internal: Boolean, val createdAt: String, val authorName: String, val fromSupport: Boolean)
data class TicketList(val tickets: List<Ticket>, val counts: Map<String, Int>, val openByType: Map<String, Int>)

data class ProfileChallenge(val id: Int, val name: String, val startDate: LocalDate, val endDate: LocalDate, val measuresDistance: Boolean,
    val distanceUnit: String, val team: String?, val minutes: Double, val distance: Double, val rank: Int, val of: Int,
    val measuresSteps: Boolean = false, val steps: Double = 0.0)
data class ProfileActivity(val type: String, val minutes: Double?, val distance: Double?, val distanceUnit: String, val measuresDistance: Boolean,
    val date: LocalDate, val startTime: String?, val comment: String?, val challengeName: String, val steps: Int? = null, val measuresSteps: Boolean = false)
/** Someone's profile as a challenge-mate sees it. challenges/activities are null when their sharing level hides them. */
data class Profile(val id: Int, val name: String, val avatarUrl: String?, val bio: String?, val memberSince: String, val sharing: String, val self: Boolean,
    val challenges: List<ProfileChallenge>?, val activities: List<ProfileActivity>?)

data class MyTeam(val id: Int, val name: String)

/** A challenge I belong to, as the dashboard reports it. */
data class Challenge(
    val id: Int,
    val name: String,
    val descriptionHtml: String,
    val startDate: LocalDate,
    val endDate: LocalDate,
    val measuresDistance: Boolean,
    val distanceUnit: String,
    val individual: Boolean,
    val role: String,
    val myTeams: List<MyTeam>,
    val myMinutes: Double,
    val myDistance: Double,
    /** A step challenge: one entry per day, counted in steps. */
    val measuresSteps: Boolean = false,
    val mySteps: Double = 0.0,
) {
    fun contains(day: LocalDate) = !day.isBefore(startDate) && !day.isAfter(endDate)
    /** Where my activity goes in this challenge: no team if individuals-only, else my (first) team. Null if I have no team yet. */
    val target: Target? get() = if (individual) Target(id, null) else myTeams.firstOrNull()?.let { Target(id, it.id) }
    val isActive: Boolean get() = !LocalDate.now().isAfter(endDate)
}

data class Target(val challengeId: Int, val teamId: Int?)

/** A team as the challenge page shows it; the invite code only comes back for my teams and ones I manage. */
data class TeamInfo(val id: Int, val name: String, val imageUrl: String?, val members: Int, val mine: Boolean, val canManage: Boolean, val inviteCode: String?)

/** The full challenge record: what owners edit, the invite code to share, and its teams. role is "admin" for a global admin who hasn't joined. */
data class ChallengeDetail(
    val id: Int, val name: String, val descriptionHtml: String, val startDate: LocalDate, val endDate: LocalDate,
    val measuresDistance: Boolean, val distanceUnit: String, val individual: Boolean, val role: String,
    val canManage: Boolean, val inviteCode: String, val teams: List<TeamInfo>,
    val measuresSteps: Boolean = false,
)

/** A challenge record as a [Challenge], for opening one I'm not in (a global admin): no team of mine, nothing logged by me. */
fun ChallengeDetail.asChallenge() = Challenge(id, name, descriptionHtml, startDate, endDate, measuresDistance, distanceUnit, individual, role,
    teams.filter { it.mine }.map { MyTeam(it.id, it.name) }, 0.0, 0.0, measuresSteps)

/** What an invite link is for. member/inTeam are only known when signed in. */
data class InvitePreview(val code: String, val isTeam: Boolean, val challengeId: Int, val challengeName: String, val startDate: LocalDate, val endDate: LocalDate,
    val measuresDistance: Boolean, val distanceUnit: String, val individual: Boolean, val members: Int, val teamName: String?, val teamMembers: Int?,
    val member: Boolean?, val inTeam: Boolean?, val measuresSteps: Boolean = false) {
    /** Nothing left to join: in the challenge, and in the team if the link was for one. */
    val alreadyIn: Boolean get() = member == true && (!isTeam || inTeam == true)
}

/** The newest Android build published on the website. */
data class AppRelease(val version: String, val versionCode: Int, val size: Long)

/** The invite code in an invite link: https://.../join/CODE, or activetogether://join/CODE. */
fun inviteCodeFrom(uri: android.net.Uri?): String? {
    if (uri == null) return null
    val segs = uri.pathSegments
    val code = when (uri.scheme) {
        "https", "http" -> if (segs.size >= 2 && segs[0] == "join") segs[1] else null
        "activetogether" -> if (uri.host == "join") segs.firstOrNull() else null
        else -> null
    }
    return code?.uppercase()?.filter { it.isLetterOrDigit() }?.takeIf { it.length in 4..32 }
}

/** Global admins: every account, and how involved it is. */
data class AdminUser(val id: Int, val name: String, val email: String, val role: String, val avatarUrl: String?, val createdAt: String,
    val challenges: Int, val activities: Int, val lastActivity: String?, val tickets: Int, val deactivatedAt: String? = null) {
    val isAdmin: Boolean get() = role == "global_admin"
}
/** Global admins: every challenge on the site. state is running | upcoming | finished. */
data class AdminChallenge(val id: Int, val name: String, val startDate: LocalDate, val endDate: LocalDate, val measuresDistance: Boolean,
    val distanceUnit: String, val individual: Boolean, val inviteCode: String, val owners: String?, val members: Int, val teams: Int,
    val activities: Int, val state: String, val purgeDate: String, val measuresSteps: Boolean = false)

/** What a new or edited challenge is set to. description is null to leave it unchanged. */
data class ChallengeFields(val name: String, val description: String?, val startDate: LocalDate, val endDate: LocalDate,
    val measuresDistance: Boolean, val distanceUnit: String, val individual: Boolean, val measuresSteps: Boolean = false)

/** A leaderboard row; userId is set for people (tap to see their profile), null for teams. */
data class Standing(val name: String, val minutes: Double, val distance: Double, val imageUrl: String?, val userId: Int? = null, val steps: Double = 0.0)
data class Leaderboard(val teams: List<Standing>, val users: List<Standing>)

data class MyActivity(
    val id: Int,
    val challengeId: Int,
    val challengeName: String,
    val teamName: String?,
    val type: String,
    val minutes: Double?,
    val distance: Double?,
    val distanceUnit: String,
    val measuresDistance: Boolean,
    val date: LocalDate,
    val startTime: String?,
    val endTime: String?,
    val comment: String?,
    val source: String,
    val hasRoute: Boolean,
    val steps: Int? = null,
    val measuresSteps: Boolean = false,
)

/** One route point: latitude, longitude, and time (epoch ms) and altitude (m) when known. */
data class RoutePoint(val lat: Double, val lon: Double, val timeMs: Long? = null, val altitude: Double? = null)

/** A device workout ready to upload into one challenge. */
data class HealthRecord(
    val target: Target,
    val activityType: String,
    val minutes: Long,
    val distanceMeters: Double?,
    val activityDate: String,
    val sourceRef: String,
    val startTime: String,
    val endTime: String,
    val route: List<RoutePoint>? = null,
)

data class ImportResult(val added: Int, val skipped: Int, val updated: Int = 0)

/** A day's step total from the phone, for one step challenge. Re-sending a day updates it. */
data class StepDay(val target: Target, val date: LocalDate, val steps: Long)

/** A failed request, keeping the HTTP status so an expired session (401) can send the user back to sign in. */
class ApiException(val status: Int, message: String) : IOException(message)

class ActiveTogetherApi(private val token: String? = null, private val baseUrl: String = SERVER_URL) {
    // Uses the mobile-specific login endpoint, not the web /api/login: that one requires a
    // reCAPTCHA token from a page this app never renders.
    fun login(email: String, password: String): String =
        request("/api/mobile/login", "POST", JSONObject().put("email", email).put("password", password)).getString("sessionToken")

    fun logout() { request("/api/logout", "POST", JSONObject()) }

    /** Signed out shows as {user: null} rather than an error, so treat that as an expired session. */
    fun me(): Me {
        val r = request("/api/me")
        if (r.isNull("user")) throw ApiException(401, "Please sign in again")
        return parseMe(r.getJSONObject("user"))
    }

    fun challenges(): List<Challenge> {
        val arr = request("/api/dashboard").getJSONArray("challenges")
        return (0 until arr.length()).map { i ->
            val c = arr.getJSONObject(i)
            val teams = c.optJSONArray("teams") ?: JSONArray()
            Challenge(
                id = c.getInt("id"),
                name = c.getString("name"),
                descriptionHtml = c.optString("description").takeUnless { c.isNull("description") }.orEmpty(),
                startDate = LocalDate.parse(c.getString("start_date")),
                endDate = LocalDate.parse(c.getString("end_date")),
                measuresDistance = c.optString("metric") == "distance",
                distanceUnit = if (c.optString("distance_unit") == "km") "km" else "mi",
                individual = c.optString("participation") == "individual",
                role = c.optString("role", "member"),
                myTeams = (0 until teams.length()).map { j -> teams.getJSONObject(j).let { MyTeam(it.getInt("id"), it.getString("name")) } },
                myMinutes = c.optDouble("myMinutes", 0.0),
                myDistance = c.optDouble("myDistance", 0.0),
                measuresSteps = c.optString("metric") == "steps",
                mySteps = c.optDouble("mySteps", 0.0),
            )
        }
    }

    fun challengeDetail(id: Int): ChallengeDetail {
        val c = request("/api/challenges/$id")
        fun str(o: JSONObject, k: String) = if (o.isNull(k)) null else o.optString(k).takeIf { it.isNotBlank() }
        val teams = c.optJSONArray("teams") ?: JSONArray()
        return ChallengeDetail(
            c.getInt("id"), c.getString("name"), str(c, "description").orEmpty(),
            LocalDate.parse(c.getString("start_date")), LocalDate.parse(c.getString("end_date")),
            c.optString("metric") == "distance", if (c.optString("distance_unit") == "km") "km" else "mi",
            c.optString("participation") == "individual", c.optString("role", "member"), c.optBoolean("canManage"),
            c.optString("invite_code"),
            (0 until teams.length()).map { i -> teams.getJSONObject(i).let { t ->
                TeamInfo(t.getInt("id"), t.getString("name"), str(t, "image_url"), t.optInt("members"), t.optBoolean("mine"), t.optBoolean("canManage"), str(t, "invite_code"))
            } },
            measuresSteps = c.optString("metric") == "steps",
        )
    }

    private fun challengeBody(f: ChallengeFields) = JSONObject()
        .put("name", f.name)
        .put("start_date", f.startDate.toString())
        .put("end_date", f.endDate.toString())
        .put("metric", if (f.measuresSteps) "steps" else if (f.measuresDistance) "distance" else "minutes")
        .put("distance_unit", f.distanceUnit)
        .put("participation", if (f.individual) "individual" else "teams")
        .apply { f.description?.let { put("description", it) } }

    /** Create a challenge (I become its owner). Returns its id and invite code. */
    fun createChallenge(f: ChallengeFields): Pair<Int, String> =
        request("/api/challenges", "POST", challengeBody(f)).let { it.getInt("id") to it.getString("invite_code") }

    fun updateChallenge(id: Int, f: ChallengeFields) { request("/api/challenges/$id", "PATCH", challengeBody(f)) }

    /** Deletes the challenge and everything logged in it, for everyone. */
    fun deleteChallenge(id: Int) { request("/api/challenges/$id", "DELETE") }

    /** Join with a challenge or team invite code. Returns the challenge id and what was joined. */
    fun join(code: String): Pair<Int, String> =
        request("/api/join", "POST", JSONObject().put("code", code.trim())).let { it.getInt("challengeId") to it.optString("name") }

    fun createTeam(challengeId: Int, name: String): Int =
        request("/api/teams", "POST", JSONObject().put("challenge_id", challengeId).put("name", name)).getInt("id")

    fun joinTeam(teamId: Int) { request("/api/teams/$teamId/join", "POST", JSONObject()) }

    /** Works signed out too, for the sign-in screen's "you're invited" card. */
    fun invitePreview(code: String): InvitePreview {
        val r = request("/api/join/preview?code=" + java.net.URLEncoder.encode(code, "UTF-8"))
        val c = r.getJSONObject("challenge"); val t = r.optJSONObject("team")
        return InvitePreview(r.getString("code"), r.optString("type") == "team", c.getInt("id"), c.getString("name"),
            LocalDate.parse(c.getString("start_date")), LocalDate.parse(c.getString("end_date")), c.optString("metric") == "distance",
            if (c.optString("distance_unit") == "km") "km" else "mi", c.optString("participation") == "individual", c.optInt("members"),
            t?.optString("name"), t?.optInt("members"),
            if (r.has("member")) r.optBoolean("member") else null, if (r.has("inTeam") && !r.isNull("inTeam")) r.optBoolean("inTeam") else null,
            c.optString("metric") == "steps")
    }

    fun androidRelease(): AppRelease? {
        val r = request("/api/app/android")
        return if (r.optBoolean("available")) AppRelease(r.getString("version"), r.getInt("versionCode"), r.optLong("size")) else null
    }
    /** A download link the phone's browser can open without being signed in (valid for 15 minutes). */
    fun androidDownloadLink(): String = baseUrl.trimEnd('/') + request("/api/app/android/link").getString("path")

    // --- Global admins ---
    fun adminUsers(): List<AdminUser> {
        val a = request("/api/admin/users").getJSONArray("users")
        return (0 until a.length()).map { i -> a.getJSONObject(i).let { u ->
            fun str(k: String) = if (u.isNull(k)) null else u.optString(k).takeIf { it.isNotBlank() }
            AdminUser(u.getInt("id"), u.getString("name"), u.getString("email"), u.optString("role", "member"), str("avatar_url"),
                u.optString("created_at").take(10), u.optInt("challenges"), u.optInt("activities"), str("last_activity"), u.optInt("tickets"), str("deactivated_at")?.take(10))
        } }
    }
    fun adminChallenges(): List<AdminChallenge> {
        val a = request("/api/admin/challenges").getJSONArray("challenges")
        return (0 until a.length()).map { i -> a.getJSONObject(i).let { c ->
            AdminChallenge(c.getInt("id"), c.getString("name"), LocalDate.parse(c.getString("start_date")), LocalDate.parse(c.getString("end_date")),
                c.optString("metric") == "distance", if (c.optString("distance_unit") == "km") "km" else "mi", c.optString("participation") == "individual",
                c.optString("invite_code"), if (c.isNull("owners")) (if (c.isNull("creator_name")) null else c.optString("creator_name")) else c.optString("owners"),
                c.optInt("members"), c.optInt("teams"), c.optInt("activities"), c.optString("state"), c.optString("purge_date"), c.optString("metric") == "steps")
        } }
    }
    /** password: blank keeps the current one (setting one signs that person out everywhere). */
    fun adminUpdateUser(id: Int, name: String, email: String, role: String, password: String) {
        request("/api/admin/users/$id", "PATCH", JSONObject().put("name", name).put("email", email).put("role", role)
            .apply { if (password.isNotEmpty()) put("password", password) })
    }
    /** Deactivated accounts can't sign in (and are signed out now); their activity still counts. */
    fun adminSetActive(id: Int, active: Boolean) { request("/api/admin/users/$id", "PATCH", JSONObject().put("active", active)) }
    /** Deletes the account with its activity, routes, memberships and tickets. */
    fun adminDeleteUser(id: Int) { request("/api/admin/users/$id", "DELETE") }
    fun adminCreateUser(name: String, email: String, role: String, password: String) {
        request("/api/admin/users", "POST", JSONObject().put("name", name).put("email", email).put("role", role).put("password", password))
    }

    fun leaderboard(challengeId: Int): Leaderboard {
        val r = request("/api/challenges/$challengeId/leaderboard")
        fun list(a: JSONArray, people: Boolean) = (0 until a.length()).map { i ->
            val x = a.getJSONObject(i)
            Standing(x.getString("name"), x.optDouble("minutes", 0.0), x.optDouble("distance", 0.0),
                (x.optString("image_url").ifBlank { x.optString("avatar_url") }).takeIf { it.isNotBlank() && it != "null" },
                if (people) x.optInt("id") else null, x.optDouble("steps", 0.0))
        }
        return Leaderboard(list(r.getJSONArray("teams"), false), list(r.getJSONArray("users"), true))
    }

    fun profile(userId: Int): Profile {
        val r = request("/api/users/$userId/profile")
        fun str(o: JSONObject, k: String) = if (o.isNull(k)) null else o.optString(k).takeIf { it.isNotBlank() }
        val challenges = r.optJSONArray("challenges")?.let { a -> (0 until a.length()).map { i -> a.getJSONObject(i).let { c ->
            ProfileChallenge(c.getInt("id"), c.getString("name"), LocalDate.parse(c.getString("start_date")), LocalDate.parse(c.getString("end_date")),
                c.optString("metric") == "distance", if (c.optString("distance_unit") == "km") "km" else "mi", str(c, "team"),
                c.optDouble("minutes", 0.0), c.optDouble("distance", 0.0), c.optInt("rank"), c.optInt("of"),
                c.optString("metric") == "steps", c.optDouble("steps", 0.0))
        } } }
        val activities = r.optJSONArray("activities")?.let { a -> (0 until a.length()).map { i -> a.getJSONObject(i).let { x ->
            ProfileActivity(x.getString("activity_type"), if (x.isNull("minutes")) null else x.getDouble("minutes"),
                if (x.isNull("distance")) null else x.getDouble("distance"), if (x.optString("distance_unit") == "km") "km" else "mi",
                x.optString("metric") == "distance", LocalDate.parse(x.getString("activity_date")), str(x, "start_time"), str(x, "comment"), x.getString("challenge_name"),
                if (x.isNull("steps") || !x.has("steps")) null else x.getInt("steps"), x.optString("metric") == "steps")
        } } }
        return Profile(r.getInt("id"), r.getString("name"), str(r, "avatar_url"), str(r, "bio"), r.optString("member_since"),
            r.optString("sharing", "summary"), r.optBoolean("self"), challenges, activities)
    }

    /** Edit one activity entry; the server checks it still fits its challenge (dates, measure). */
    /** A step-challenge entry: just the day's count, its date and a comment. */
    fun editSteps(id: Int, date: LocalDate, steps: Int, comment: String) {
        request("/api/activities/$id", "PATCH", JSONObject().put("steps", steps).put("activity_date", date.toString()).put("comment", comment))
    }

    fun editActivity(id: Int, type: String, date: LocalDate, minutes: Int?, distance: Double?, unit: String, startTime: String?, endTime: String?, comment: String) {
        val body = JSONObject()
            .put("activity_type", type)
            .put("activity_date", date.toString())
            .put("minutes", minutes?.toString() ?: "")
            .put("distance", distance?.toString() ?: "")
            .put("distance_unit", unit)
            .put("start_time", startTime ?: "")
            .put("end_time", endTime ?: "")
            .put("comment", comment)
        request("/api/activities/$id", "PATCH", body)
    }

    fun myActivities(offset: Int, limit: Int = 30): Pair<List<MyActivity>, Boolean> {
        val r = request("/api/me/activities?limit=$limit&offset=$offset")
        val arr = r.getJSONArray("activities")
        val list = (0 until arr.length()).map { i ->
            val a = arr.getJSONObject(i)
            MyActivity(
                id = a.getInt("id"),
                challengeId = a.getInt("challenge_id"),
                challengeName = a.getString("challenge_name"),
                teamName = a.optString("team_name").takeUnless { a.isNull("team_name") },
                type = a.getString("activity_type"),
                minutes = if (a.isNull("minutes")) null else a.getDouble("minutes"),
                distance = if (a.isNull("distance")) null else a.getDouble("distance"),
                distanceUnit = if (a.optString("distance_unit") == "km") "km" else "mi",
                measuresDistance = a.optString("metric") == "distance",
                date = LocalDate.parse(a.getString("activity_date")),
                startTime = a.optString("start_time").takeUnless { a.isNull("start_time") },
                endTime = a.optString("end_time").takeUnless { a.isNull("end_time") },
                comment = a.optString("comment").takeUnless { a.isNull("comment") },
                source = a.optString("source"),
                hasRoute = a.optBoolean("has_route"),
                steps = if (a.isNull("steps") || !a.has("steps")) null else a.getInt("steps"),
                measuresSteps = a.optString("metric") == "steps",
            )
        }
        return list to r.optBoolean("more")
    }

    fun route(activityId: Int): List<RoutePoint> {
        val pts = request("/api/activities/$activityId/route").getJSONArray("points")
        return (0 until pts.length()).map { i ->
            val p = pts.getJSONArray(i)
            RoutePoint(p.getDouble(0), p.getDouble(1),
                if (p.length() > 2 && !p.isNull(2)) p.getLong(2) else null,
                if (p.length() > 3 && !p.isNull(3)) p.getDouble(3) else null)
        }
    }

    fun deleteActivity(id: Int) { request("/api/activities/$id", "DELETE") }

    /** Manual log into one or more challenges at once (all or none). */
    fun logActivity(
        targets: List<Target>, type: String, date: LocalDate, minutes: Int?, distance: Double?, unit: String,
        startTime: String?, endTime: String?, comment: String?, steps: Int? = null,
    ): Int {
        val body = JSONObject()
            .put("targets", JSONArray(targets.map { t -> JSONObject().put("challenge_id", t.challengeId).apply { t.teamId?.let { put("team_id", it) } } }))
            .put("activity_type", type)
            .put("activity_date", date.toString())
            .put("minutes", minutes ?: JSONObject.NULL)
            .put("comment", comment ?: "")
        if (distance != null) body.put("distance", distance).put("distance_unit", unit)
        if (steps != null) body.put("steps", steps)
        if (!startTime.isNullOrBlank() && !endTime.isNullOrBlank()) body.put("start_time", startTime).put("end_time", endTime)
        return request("/api/activities", "POST", body).optInt("created", targets.size)
    }

    /** Which challenges each of these device records is already in. */
    fun syncedIn(refs: List<String>): Map<String, Set<Int>> {
        if (refs.isEmpty()) return emptyMap()
        val r = request("/api/health/synced", "POST", JSONObject().put("source", "health_connect").put("refs", JSONArray(refs)))
        val obj = r.optJSONObject("syncedIn") ?: return emptyMap()
        return obj.keys().asSequence().associateWith { k -> obj.getJSONArray(k).let { a -> (0 until a.length()).map { a.getInt(it) }.toSet() } }
    }

    fun importHealth(records: List<HealthRecord>): ImportResult {
        val payload = JSONObject()
            .put("source", "health_connect")
            .put("records", JSONArray(records.map { r ->
                JSONObject()
                    .put("challenge_id", r.target.challengeId)
                    .apply { r.target.teamId?.let { put("team_id", it) } }
                    .put("activity_type", r.activityType)
                    .put("minutes", r.minutes)
                    .put("activity_date", r.activityDate)
                    .put("source_ref", r.sourceRef)
                    .put("start_time", r.startTime)
                    .put("end_time", r.endTime)
                    .apply { r.distanceMeters?.let { put("distance_m", it) } }
                    .apply {
                        r.route?.let { pts ->
                            put("route", JSONArray(pts.map { p ->
                                JSONArray().put(p.lat).put(p.lon).put(p.timeMs ?: JSONObject.NULL).put(p.altitude ?: JSONObject.NULL)
                            }))
                        }
                    }
            }))
        val response = request("/api/health/import", "POST", payload)
        return ImportResult(response.getInt("added"), response.getInt("skipped"), response.optInt("updated"))
    }

    /** Daily step totals; the server adds new days and updates days already sent. */
    fun importSteps(days: List<StepDay>): ImportResult {
        if (days.isEmpty()) return ImportResult(0, 0)
        val payload = JSONObject().put("source", "health_connect").put("records", JSONArray(days.map { d ->
            JSONObject().put("challenge_id", d.target.challengeId).apply { d.target.teamId?.let { put("team_id", it) } }
                .put("activity_type", "Steps").put("steps", d.steps).put("activity_date", d.date.toString()).put("source_ref", "steps:${d.date}")
        }))
        val r = request("/api/health/import", "POST", payload)
        return ImportResult(r.getInt("added"), r.getInt("skipped"), r.optInt("updated"))
    }

    fun updateProfile(name: String?, email: String?, currentPassword: String?, newPassword: String?, avatarUrl: String?,
                      bio: String? = null, sharing: String? = null): Me {
        val body = JSONObject()
        bio?.let { body.put("bio", it) }
        sharing?.let { body.put("profileSharing", it) }
        name?.let { body.put("name", it) }
        email?.let { body.put("email", it) }
        currentPassword?.takeIf { it.isNotEmpty() }?.let { body.put("currentPassword", it) }
        newPassword?.takeIf { it.isNotEmpty() }?.let { body.put("newPassword", it) }
        avatarUrl?.let { body.put("avatarUrl", it) }
        return parseMe(request("/api/me", "PATCH", body).getJSONObject("user"))
    }

    // --- Help & support tickets ---
    private fun parseTicket(t: JSONObject): Ticket {
        fun str(k: String) = if (t.isNull(k)) null else t.optString(k).takeIf { it.isNotBlank() }
        val rep = t.optJSONObject("reporter")
        return Ticket(t.getInt("id"), t.getString("type"), t.getString("title"), t.optString("description"), t.getString("status"), str("resolution"),
            str("image_url"), str("client_info"), t.optString("created_at"), t.optString("updated_at"), rep?.optString("name").orEmpty(),
            rep?.let { if (it.isNull("email")) null else it.optString("email").takeIf { e -> e.isNotBlank() } },
            t.optInt("comment_count"), t.optBoolean("unread"), t.optBoolean("mine"))
    }
    /** My tickets, or (admins) everyone's with counts; status may be "open" for new/in progress/planned. */
    fun tickets(all: Boolean = false, status: String? = null, type: String? = null): TicketList {
        val q = buildList { if (all) add("scope=all"); status?.let { add("status=$it") }; type?.let { add("type=$it") } }.joinToString("&")
        val r = request("/api/tickets" + if (q.isNotEmpty()) "?$q" else "")
        val arr = r.getJSONArray("tickets")
        fun counts(k: String) = r.optJSONObject(k)?.let { o -> o.keys().asSequence().associateWith { o.getInt(it) } }.orEmpty()
        return TicketList((0 until arr.length()).map { parseTicket(arr.getJSONObject(it)) }, counts("counts"), counts("byType"))
    }
    fun ticket(id: Int): Pair<Ticket, List<TicketComment>> {
        val r = request("/api/tickets/$id")
        val c = r.getJSONArray("comments")
        return parseTicket(r) to (0 until c.length()).map { i -> c.getJSONObject(i).let {
            TicketComment(it.getInt("id"), it.getString("body"), it.optBoolean("internal"), it.optString("created_at"),
                it.optJSONObject("author")?.optString("name").orEmpty(), it.optBoolean("from_support"))
        } }
    }
    fun createTicket(type: String, title: String, description: String, imageUrl: String?, clientInfo: String): Int =
        request("/api/tickets", "POST", JSONObject().put("type", type).put("title", title).put("description", description)
            .put("client_info", clientInfo).apply { imageUrl?.let { put("image_url", it) } }).getInt("id")
    fun replyTicket(id: Int, body: String, internal: Boolean) { request("/api/tickets/$id/comments", "POST", JSONObject().put("body", body).put("internal", internal)) }
    fun updateTicket(id: Int, status: String, resolution: String) { request("/api/tickets/$id", "PATCH", JSONObject().put("status", status).put("resolution", resolution)) }
    /** Unread replies on my tickets, and (admins) tickets waiting for support. */
    fun ticketBadge(): Pair<Int, Int> = request("/api/tickets/badge").let { it.optInt("mine") to it.optInt("admin") }

    /** Upload an image as a data: URL; returns its /uploads/... path. */
    fun uploadImage(dataUrl: String): String = request("/api/uploads", "POST", JSONObject().put("dataUrl", dataUrl)).getString("url")

    private fun parseMe(u: JSONObject) = Me(u.getInt("id"), u.getString("name"), u.getString("email"),
        u.optString("avatar_url").ifBlank { u.optString("avatarUrl") }.takeIf { it.isNotBlank() && it != "null" },
        if (u.isNull("bio")) null else u.optString("bio").takeIf { it.isNotBlank() },
        u.optString("profile_sharing").ifBlank { "summary" }, u.optString("role").ifBlank { "member" })

    private fun request(path: String, method: String = "GET", body: JSONObject? = null): JSONObject {
        val connection = URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 15_000
        connection.readTimeout = 60_000
        connection.setRequestProperty("Accept", "application/json")
        token?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
        if (body != null) {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
        }
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (status !in 200..299) {
            val message = runCatching { JSONObject(text).optString("error") }.getOrDefault("")
            throw ApiException(status, message.ifBlank { "Request failed with HTTP $status" })
        }
        return JSONObject(text.ifBlank { "{}" })
    }
}

/** Absolute URL for a server path such as /uploads/abc.png. */
fun serverUrl(path: String?): String? = path?.let { if (it.startsWith("http")) it else SERVER_URL + it }
