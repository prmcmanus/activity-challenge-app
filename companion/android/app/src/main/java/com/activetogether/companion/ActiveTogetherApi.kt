package com.activetogether.companion

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

data class TeamOption(val teamId: Int, val teamName: String, val challengeId: Int, val challengeName: String) {
    override fun toString() = "$challengeName — $teamName"
}
data class Bootstrap(val teamOptions: List<TeamOption>)
data class HealthRecord(val teamId: Int, val challengeId: Int, val activityType: String, val minutes: Long, val activityDate: String, val sourceRef: String)
data class ImportResult(val added: Int, val skipped: Int)

class ActiveTogetherApi(private val baseUrl: String) {
    fun login(email: String, password: String): String {
        val response = request(
            path = "/api/login",
            method = "POST",
            body = JSONObject().put("email", email).put("password", password),
        )
        return response.getString("sessionToken")
    }

    /**
     * A team only appears here if this account is already a member of it — joining a
     * challenge or team (by invite code) happens in the web app, not this sync-only companion.
     */
    fun bootstrap(token: String): Bootstrap {
        val response = request("/api/mobile/bootstrap", token = token)
        val challenges = response.getJSONArray("challenges")
        val options = mutableListOf<TeamOption>()
        for (i in 0 until challenges.length()) {
            val c = challenges.getJSONObject(i)
            val teams = c.getJSONArray("teams")
            for (j in 0 until teams.length()) {
                val t = teams.getJSONObject(j)
                options.add(TeamOption(t.getInt("id"), t.getString("name"), c.getInt("id"), c.getString("name")))
            }
        }
        return Bootstrap(options)
    }

    fun importHealth(token: String, records: List<HealthRecord>): ImportResult {
        val payload = JSONObject()
            .put("source", "health_connect")
            .put("records", JSONArray(records.map {
                JSONObject()
                    .put("team_id", it.teamId)
                    .put("challenge_id", it.challengeId)
                    .put("activity_type", it.activityType)
                    .put("minutes", it.minutes)
                    .put("activity_date", it.activityDate)
                    .put("source_ref", it.sourceRef)
            }))
        val response = request("/api/health/import", "POST", token, payload)
        return ImportResult(response.getInt("added"), response.getInt("skipped"))
    }

    private fun request(path: String, method: String = "GET", token: String? = null, body: JSONObject? = null): JSONObject {
        val connection = URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection
        connection.requestMethod = method
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
            throw IOException(message.ifBlank { "Request failed with HTTP $status" })
        }
        return JSONObject(text)
    }
}
