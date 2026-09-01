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
    private lateinit var challengeSpinner: Spinner
    private var teams = emptyList<Team>()
    private var challenges = emptyList<Challenge>()

    private val permissionLauncher = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract(),
    ) { granted ->
        if (granted.containsAll(health.permissions)) {
            sync()
        } else {
            status.text = "Health Connect permission was not granted."
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        serverUrl = EditText(this).apply { hint = "Server URL"; setText(prefs.getString("serverUrl", "http://10.0.2.2:3000")) }
        email = EditText(this).apply { hint = "Email"; setText(prefs.getString("email", "admin@example.com")) }
        password = EditText(this).apply { hint = "Password"; setText("ChangeMe123!") }
        status = TextView(this).apply { text = "Sign in, choose a team and challenge, then sync Health Connect exercise sessions." }
        teamSpinner = Spinner(this)
        challengeSpinner = Spinner(this)
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
            addView(TextView(context).apply { text = "Active Together Companion"; textSize = 24f })
            addView(serverUrl)
            addView(email)
            addView(password)
            addView(Button(context).apply { text = "Sign in"; setOnClickListener { signIn() } })
            addView(teamSpinner)
            addView(challengeSpinner)
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
                teams = it.teams
                challenges = it.challenges
                teamSpinner.adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, teams.map(Team::name))
                challengeSpinner.adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, challenges.map(Challenge::name))
                status.text = "Signed in. Found ${teams.size} team(s) and ${challenges.size} active challenge(s)."
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
            if (health.hasPermissions()) {
                sync()
            } else {
                permissionLauncher.launch(health.permissions)
            }
        }
    }

    private fun sync() {
        val token = prefs.getString("token", null)
        if (token.isNullOrBlank() || teams.isEmpty() || challenges.isEmpty()) {
            status.text = "Sign in and select a team/challenge before syncing."
            return
        }

        val team = teams[teamSpinner.selectedItemPosition]
        val challenge = challenges[challengeSpinner.selectedItemPosition]
        lifecycleScope.launch {
            status.text = "Reading Health Connect..."
            runCatching {
                withContext(Dispatchers.IO) {
                    val records = health.readExerciseSessions(team.id, challenge.id)
                    api().importHealth(token, records)
                }
            }.onSuccess {
                status.text = "Sync complete. Added ${it.added}, skipped ${it.skipped}."
            }.onFailure {
                status.text = "Sync failed: ${it.message}"
            }
        }
    }

    private fun api() = ActiveTogetherApi(serverUrl.text.toString())
}
