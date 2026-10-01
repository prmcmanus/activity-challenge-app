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
data class Me(val id: Int, val name: String, val email: String, val avatarUrl: String?, val bio: String? = null, val sharing: String = "summary")

data class ProfileChallenge(val id: Int, val name: String, val startDate: LocalDate, val endDate: LocalDate, val measuresDistance: Boolean,
    val distanceUnit: String, val team: String?, val minutes: Double, val distance: Double, val rank: Int, val of: Int)
data class ProfileActivity(val type: String, val minutes: Double?, val distance: Double?, val distanceUnit: String, val measuresDistance: Boolean,
    val date: LocalDate, val startTime: String?, val comment: String?, val challengeName: String)
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
) {
    fun contains(day: LocalDate) = !day.isBefore(startDate) && !day.isAfter(endDate)
    /** Where my activity goes in this challenge: no team if individuals-only, else my (first) team. Null if I have no team yet. */
    val target: Target? get() = if (individual) Target(id, null) else myTeams.firstOrNull()?.let { Target(id, it.id) }
    val isActive: Boolean get() = !LocalDate.now().isAfter(endDate)
}

data class Target(val challengeId: Int, val teamId: Int?)

/** A leaderboard row; userId is set for people (tap to see their profile), null for teams. */
data class Standing(val name: String, val minutes: Double, val distance: Double, val imageUrl: String?, val userId: Int? = null)
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

data class ImportResult(val added: Int, val skipped: Int)

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
            )
        }
    }

    fun leaderboard(challengeId: Int): Leaderboard {
        val r = request("/api/challenges/$challengeId/leaderboard")
        fun list(a: JSONArray, people: Boolean) = (0 until a.length()).map { i ->
            val x = a.getJSONObject(i)
            Standing(x.getString("name"), x.optDouble("minutes", 0.0), x.optDouble("distance", 0.0),
                (x.optString("image_url").ifBlank { x.optString("avatar_url") }).takeIf { it.isNotBlank() && it != "null" },
                if (people) x.optInt("id") else null)
        }
        return Leaderboard(list(r.getJSONArray("teams"), false), list(r.getJSONArray("users"), true))
    }

    fun profile(userId: Int): Profile {
        val r = request("/api/users/$userId/profile")
        fun str(o: JSONObject, k: String) = if (o.isNull(k)) null else o.optString(k).takeIf { it.isNotBlank() }
        val challenges = r.optJSONArray("challenges")?.let { a -> (0 until a.length()).map { i -> a.getJSONObject(i).let { c ->
            ProfileChallenge(c.getInt("id"), c.getString("name"), LocalDate.parse(c.getString("start_date")), LocalDate.parse(c.getString("end_date")),
                c.optString("metric") == "distance", if (c.optString("distance_unit") == "km") "km" else "mi", str(c, "team"),
                c.optDouble("minutes", 0.0), c.optDouble("distance", 0.0), c.optInt("rank"), c.optInt("of"))
        } } }
        val activities = r.optJSONArray("activities")?.let { a -> (0 until a.length()).map { i -> a.getJSONObject(i).let { x ->
            ProfileActivity(x.getString("activity_type"), if (x.isNull("minutes")) null else x.getDouble("minutes"),
                if (x.isNull("distance")) null else x.getDouble("distance"), if (x.optString("distance_unit") == "km") "km" else "mi",
                x.optString("metric") == "distance", LocalDate.parse(x.getString("activity_date")), str(x, "start_time"), str(x, "comment"), x.getString("challenge_name"))
        } } }
        return Profile(r.getInt("id"), r.getString("name"), str(r, "avatar_url"), str(r, "bio"), r.optString("member_since"),
            r.optString("sharing", "summary"), r.optBoolean("self"), challenges, activities)
    }

    /** Edit one activity entry; the server checks it still fits its challenge (dates, measure). */
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
        startTime: String?, endTime: String?, comment: String?,
    ): Int {
        val body = JSONObject()
            .put("targets", JSONArray(targets.map { t -> JSONObject().put("challenge_id", t.challengeId).apply { t.teamId?.let { put("team_id", it) } } }))
            .put("activity_type", type)
            .put("activity_date", date.toString())
            .put("minutes", minutes ?: JSONObject.NULL)
            .put("comment", comment ?: "")
        if (distance != null) body.put("distance", distance).put("distance_unit", unit)
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
        return ImportResult(response.getInt("added"), response.getInt("skipped"))
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

    /** Upload an image as a data: URL; returns its /uploads/... path. */
    fun uploadImage(dataUrl: String): String = request("/api/uploads", "POST", JSONObject().put("dataUrl", dataUrl)).getString("url")

    private fun parseMe(u: JSONObject) = Me(u.getInt("id"), u.getString("name"), u.getString("email"),
        u.optString("avatar_url").ifBlank { u.optString("avatarUrl") }.takeIf { it.isNotBlank() && it != "null" },
        if (u.isNull("bio")) null else u.optString("bio").takeIf { it.isNotBlank() },
        u.optString("profile_sharing").ifBlank { "summary" })

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
