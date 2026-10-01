package com.activetogether.companion

import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.health.connect.client.PermissionController
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private val health = HealthConnectSync(this)
    private val prefs by lazy { getSharedPreferences("active-together", MODE_PRIVATE) }
    private lateinit var serverUrl: EditText
    private lateinit var email: EditText
    private lateinit var password: EditText
    private lateinit var status: TextView
    private lateinit var teamSpinner: Spinner
    private var teamOptions = emptyList<TeamOption>()

    private val permissionLauncher = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract(),
    ) { granted ->
        // Distance is optional - declining it still syncs sessions, just without distance.
        if (granted.containsAll(health.requiredPermissions)) {
            sync()
        } else {
            status.text = "Health Connect permission was not granted."
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        serverUrl = EditText(this).apply { hint = "Server URL"; setText(prefs.getString("serverUrl", "http://10.0.2.2:3000")) }
        email = EditText(this).apply { hint = "Email"; setText(prefs.getString("email", "")) }
        password = EditText(this).apply { hint = "Password" }
        status = TextView(this).apply { text = "Sign in, then pick the challenge/team to sync into. Join challenges and teams in the web app first — this companion only syncs Health Connect data into a team you already belong to." }
        teamSpinner = Spinner(this)
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
            addView(TextView(context).apply { text = "Active Together Companion"; textSize = 24f })
            addView(serverUrl)
            addView(email)
            addView(password)
            addView(Button(context).apply { text = "Sign in"; setOnClickListener { signIn() } })
            addView(teamSpinner)
            addView(Button(context).apply { text = "Sync Health Connect"; setOnClickListener { ensurePermissionsThenSync() } })
            addView(status)
        })
    }

    private fun signIn() {
        lifecycleScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val api = api()
                    val token = api.login(email.text.toString(), password.text.toString())
                    prefs.edit()
                        .putString("serverUrl", serverUrl.text.toString())
                        .putString("email", email.text.toString())
                        .putString("token", token)
                        .apply()
                    api.bootstrap(token)
                }
            }.onSuccess {
                teamOptions = it.teamOptions
                teamSpinner.adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, teamOptions.map(TeamOption::toString))
                status.text = if (teamOptions.isEmpty())
                    "Signed in, but you are not in any team yet. Join a challenge and a team in the web app, then sign in here again."
                else
                    "Signed in. Found ${teamOptions.size} team membership(s)."
            }.onFailure {
                status.text = "Sign in failed: ${it.message}"
            }
        }
    }

    private fun ensurePermissionsThenSync() {
        if (!health.isAvailable()) {
            status.text = "Health Connect is not available on this device."
            return
        }
        lifecycleScope.launch {
            val granted = health.grantedPermissions()
            // Ask for distance once (existing installs only ever granted exercise); after that,
            // a decline is respected rather than prompting on every sync.
            val askedDistance = prefs.getBoolean("askedDistance", false)
            if (granted.containsAll(health.permissions) || (granted.containsAll(health.requiredPermissions) && askedDistance)) {
                sync()
            } else {
                prefs.edit().putBoolean("askedDistance", true).apply()
                permissionLauncher.launch(health.permissions)
            }
        }
    }

    private fun sync() {
        val token = prefs.getString("token", null)
        if (token.isNullOrBlank() || teamOptions.isEmpty()) {
            status.text = "Sign in and select a challenge/team before syncing."
            return
        }

        val team = teamOptions[teamSpinner.selectedItemPosition]
        lifecycleScope.launch {
            status.text = "Reading Health Connect..."
            runCatching {
                withContext(Dispatchers.IO) {
                    val records = health.readExerciseSessions(team.teamId, team.challengeId)
                    api().importHealth(token, records)
                }
            }.onSuccess {
                status.text = "Sync complete. Added ${it.added}, skipped ${it.skipped}." +
                    if (team.measuresDistance && it.skipped > 0) " Sessions with no recorded distance are skipped in a distance challenge." else ""
            }.onFailure {
                status.text = "Sync failed: ${it.message}"
            }
        }
    }

    private fun api() = ActiveTogetherApi(serverUrl.text.toString())
}
