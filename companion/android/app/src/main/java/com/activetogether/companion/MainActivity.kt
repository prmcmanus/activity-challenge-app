package com.activetogether.companion

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The one server this app talks to. */
const val SERVER_URL = "https://activetogether.team"

class MainActivity : ComponentActivity() {
    private val health = HealthConnectSync(this)
    private val prefs by lazy { getSharedPreferences("active-together", MODE_PRIVATE) }
    private lateinit var email: EditText
    private lateinit var password: EditText
    private lateinit var status: TextView
    private lateinit var teamSpinner: Spinner
    private lateinit var openSettings: Button
    private var teamOptions = emptyList<TeamOption>()

    private val permissionLauncher = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract(),
    ) { granted ->
        // Distance is optional - declining it still syncs sessions, just without distance.
        if (granted.containsAll(health.requiredPermissions)) {
            openSettings.visibility = View.GONE
            sync()
        } else {
            // Android stops showing the dialog after it has been declined twice, and the launcher
            // then returns at once with nothing granted - so offer the settings screen instead.
            status.text = "Health Connect access to exercise was not granted. Tap \"Open Health Connect permissions\" to allow it, then sync again."
            openSettings.visibility = View.VISIBLE
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        email = EditText(this).apply {
            hint = "Email"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
            setText(prefs.getString("email", ""))
        }
        password = EditText(this).apply {
            hint = "Password"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        status = TextView(this).apply {
            text = "Sign in, then pick the challenge to sync into. Join challenges and teams in the web app first — this companion only syncs Health Connect data into challenges you already belong to."
            setPadding(0, 24, 0, 0)
        }
        teamSpinner = Spinner(this)
        openSettings = Button(this).apply {
            text = "Open Health Connect permissions"
            visibility = View.GONE
            setOnClickListener { openHealthConnectPermissions() }
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
            addView(TextView(context).apply { text = "Active Together Companion"; textSize = 24f })
            addView(TextView(context).apply { text = SERVER_URL; setPadding(0, 4, 0, 16) })
            addView(email)
            addView(password)
            addView(Button(context).apply { text = "Sign in"; setOnClickListener { signIn() } })
            addView(teamSpinner)
            addView(Button(context).apply { text = "Sync Health Connect"; setOnClickListener { ensurePermissionsThenSync() } })
            addView(openSettings)
            addView(status)
        }
        val root = ScrollView(this).apply { addView(content) }
        // Targeting Android 15 makes the window edge-to-edge: without this the title sits under the
        // status bar and the keyboard covers the fields. Pad by the system bars and the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
    }

    private fun signIn() {
        status.text = "Signing in..."
        lifecycleScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val api = api()
                    val token = api.login(email.text.toString().trim(), password.text.toString())
                    prefs.edit()
                        .putString("email", email.text.toString().trim())
                        .putString("token", token)
                        .apply()
                    api.bootstrap(token)
                }
            }.onSuccess {
                password.setText("")
                teamOptions = it.teamOptions
                teamSpinner.adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, teamOptions.map(TeamOption::toString))
                status.text = if (teamOptions.isEmpty())
                    "Signed in, but you are not in any challenge yet. Join one in the web app, then sign in here again."
                else
                    "Signed in. Found ${teamOptions.size} challenge(s) to sync into."
            }.onFailure {
                status.text = "Sign in failed: ${it.message}"
            }
        }
    }

    private fun ensurePermissionsThenSync() {
        when (HealthConnectClient.getSdkStatus(this)) {
            HealthConnectClient.SDK_UNAVAILABLE -> {
                status.text = "Health Connect is not available on this device."
                return
            }
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                status.text = "Health Connect needs installing or updating. Opening the Play Store..."
                openPlayStore()
                return
            }
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
                status.text = "Asking Health Connect for permission..."
                permissionLauncher.launch(health.permissions)
            }
        }
    }

    /** Health Connect's own screen for this app's permissions - the way back after the dialog stops appearing. */
    private fun openHealthConnectPermissions() {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            Intent("android.health.connect.action.MANAGE_HEALTH_PERMISSIONS")
                .putExtra(Intent.EXTRA_PACKAGE_NAME, packageName)
        } else {
            Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
        }
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            runCatching { startActivity(Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)) }
                .onFailure { status.text = "Open the Health Connect app and allow Active Together Companion to read exercise and distance." }
        }
    }

    private fun openPlayStore() {
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("market://details?id=com.google.android.apps.healthdata")).setPackage("com.android.vending"))
        }
    }

    private fun sync() {
        val token = prefs.getString("token", null)
        if (token.isNullOrBlank() || teamOptions.isEmpty()) {
            status.text = "Sign in and select a challenge before syncing."
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

    private fun api() = ActiveTogetherApi(SERVER_URL)
}
