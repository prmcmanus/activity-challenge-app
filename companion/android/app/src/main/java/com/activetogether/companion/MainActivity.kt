package com.activetogether.companion

import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
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
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The one server this app talks to. */
const val SERVER_URL = "https://activetogether.team"

/** Activity types offered in the review; a session's own label is added if it isn't one of these. */
val ACTIVITY_TYPES = listOf("Walking", "Running", "Cycling", "Swimming", "Hiking", "Rowing", "Wheelchair",
    "Strength training", "Yoga", "HIIT", "Elliptical", "Exercise")

class MainActivity : ComponentActivity() {
    private val health = HealthConnectSync(this)
    private val prefs by lazy { getSharedPreferences("active-together", MODE_PRIVATE) }
    private lateinit var loginPanel: LinearLayout
    private lateinit var sessionPanel: LinearLayout
    private lateinit var signedInAs: TextView
    private lateinit var email: EditText
    private lateinit var password: EditText
    private lateinit var status: TextView
    private lateinit var teamSpinner: Spinner
    private lateinit var challengeDates: TextView
    private lateinit var openSettings: Button
    private var teamOptions = emptyList<TeamOption>()

    private val permissionLauncher = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract(),
    ) { granted ->
        // Distance is optional - declining it still syncs sessions, just without distance.
        if (granted.containsAll(health.requiredPermissions)) {
            openSettings.visibility = View.GONE
            readAndReview()
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
        loginPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(email)
            addView(password)
            addView(Button(context).apply { text = "Sign in"; setOnClickListener { signIn() } })
        }

        signedInAs = TextView(this).apply { textSize = 16f }
        teamSpinner = Spinner(this)
        challengeDates = TextView(this).apply { setPadding(0, 0, 0, 8) }
        teamSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) = showDates()
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }
        openSettings = Button(this).apply {
            text = "Open Health Connect permissions"
            visibility = View.GONE
            setOnClickListener { openHealthConnectPermissions() }
        }
        sessionPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(signedInAs, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
                addView(Button(context).apply { text = "Sign out"; setOnClickListener { signOut() } })
            })
            addView(TextView(context).apply { text = "Sync into"; setPadding(0, 16, 0, 0) })
            addView(teamSpinner)
            addView(challengeDates)
            addView(Button(context).apply { text = "Review and sync Health Connect"; setOnClickListener { ensurePermissionsThenSync() } })
            addView(openSettings)
        }

        status = TextView(this).apply { setPadding(0, 24, 0, 0) }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
            addView(TextView(context).apply { text = "Active Together Companion"; textSize = 24f })
            addView(TextView(context).apply { text = SERVER_URL; setPadding(0, 4, 0, 16) })
            addView(loginPanel)
            addView(sessionPanel)
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

        // Stay signed in across launches: a saved session goes straight to the sync screen.
        val token = prefs.getString("token", null)
        if (token.isNullOrBlank()) showSignedOut() else loadChallenges(token)
    }

    private fun showSignedOut(message: String = "Sign in with your Active Together account. Join challenges and teams in the web app first — this companion only syncs into challenges you already belong to.") {
        loginPanel.visibility = View.VISIBLE
        sessionPanel.visibility = View.GONE
        status.text = message
    }

    private fun showSignedIn(name: String) {
        loginPanel.visibility = View.GONE
        sessionPanel.visibility = View.VISIBLE
        signedInAs.text = "Signed in as ${name.ifBlank { prefs.getString("email", "") }}"
    }

    private fun signIn() {
        status.text = "Signing in..."
        lifecycleScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val token = api().login(email.text.toString().trim(), password.text.toString())
                    prefs.edit().putString("email", email.text.toString().trim()).putString("token", token).apply()
                    token
                }
            }.onSuccess {
                password.setText("")
                loadChallenges(it)
            }.onFailure {
                status.text = "Sign in failed: ${it.message}"
            }
        }
    }

    private fun loadChallenges(token: String) {
        showSignedIn(prefs.getString("name", "").orEmpty())
        status.text = "Loading your challenges..."
        lifecycleScope.launch {
            runCatching { withContext(Dispatchers.IO) { api().bootstrap(token) } }
                .onSuccess {
                    prefs.edit().putString("name", it.userName).apply()
                    showSignedIn(it.userName)
                    teamOptions = it.teamOptions
                    teamSpinner.adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, teamOptions.map(TeamOption::toString))
                    showDates()
                    status.text = if (teamOptions.isEmpty())
                        "You are not in any challenge yet. Join one in the web app, then come back and sign in again."
                    else ""
                }
                .onFailure {
                    if (it is ApiException && it.status == 401) {
                        prefs.edit().remove("token").apply()
                        showSignedOut("Your session has expired. Please sign in again.")
                    } else {
                        status.text = "Could not load your challenges: ${it.message}"
                    }
                }
        }
    }

    private fun signOut() {
        val token = prefs.getString("token", null)
        prefs.edit().remove("token").remove("name").apply()
        teamOptions = emptyList()
        teamSpinner.adapter = null
        showSignedOut("Signed out.")
        if (!token.isNullOrBlank()) lifecycleScope.launch { runCatching { withContext(Dispatchers.IO) { api().logout(token) } } }
    }

    private fun selectedOption(): TeamOption? = teamOptions.getOrNull(teamSpinner.selectedItemPosition)

    private fun showDates() {
        val o = selectedOption() ?: run { challengeDates.text = ""; return }
        challengeDates.text = "Challenge runs ${fmtDay(o.startDate)} – ${fmtDay(o.endDate)}. Only workouts in that period are synced."
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
                readAndReview()
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
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.google.android.apps.healthdata")).setPackage("com.android.vending"))
        }
    }

    /** Read the challenge period's sessions, ask the server which are already in, then let the user choose. */
    private fun readAndReview() {
        val token = prefs.getString("token", null)
        val option = selectedOption()
        if (token.isNullOrBlank() || option == null) {
            status.text = "Choose a challenge before syncing."
            return
        }
        lifecycleScope.launch {
            status.text = "Reading Health Connect..."
            runCatching {
                withContext(Dispatchers.IO) {
                    val records = health.readExerciseSessions(option)
                    records to api().syncedRefs(token, records.map { it.sourceRef })
                }
            }.onSuccess { (records, synced) ->
                if (records.isEmpty()) {
                    status.text = "No workouts found in Health Connect between ${fmtDay(option.startDate)} and ${fmtDay(option.endDate)} (Health Connect shares at most the last 30 days)."
                } else {
                    status.text = ""
                    showReview(token, option, records, synced)
                }
            }.onFailure {
                status.text = "Could not read workouts: ${it.message}"
            }
        }
    }

    /**
     * What is about to be uploaded, one row per workout: tick to include, and an activity type to
     * change what it is logged as. Already-synced workouts are shown but can't be sent again, and
     * in a distance challenge a workout with no distance can't count, so it is shown unticked.
     */
    private fun showReview(token: String, option: TeamOption, records: List<HealthRecord>, synced: Set<String>) {
        data class Row(val record: HealthRecord, val check: CheckBox, val type: Spinner)
        val rows = mutableListOf<Row>()
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 16, 48, 0) }
        list.addView(TextView(this).apply {
            text = "Into: $option\nTick the workouts to sync and check each activity type. Only the type, date, times, minutes and distance shown here are uploaded."
            setPadding(0, 0, 0, 16)
        })
        for (r in records) {
            val already = r.sourceRef in synced
            val noDistance = option.measuresDistance && r.distanceMeters == null
            val types = if (r.activityType in ACTIVITY_TYPES) ACTIVITY_TYPES else listOf(r.activityType) + ACTIVITY_TYPES
            val check = CheckBox(this).apply {
                text = describe(r, option) + when {
                    already -> "\nAlready synced"
                    noDistance -> "\nNo distance recorded - doesn't count in a distance challenge"
                    else -> ""
                }
                isChecked = !already && !noDistance
                isEnabled = !already
                if (!already && !noDistance) setTypeface(typeface, Typeface.BOLD)
            }
            val type = Spinner(this).apply {
                adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, types)
                setSelection(types.indexOf(r.activityType).coerceAtLeast(0))
                isEnabled = !already
            }
            list.addView(check)
            list.addView(type)
            rows.add(Row(r, check, type))
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle("Review ${records.size} workout${if (records.size == 1) "" else "s"}")
            .setView(ScrollView(this).apply { addView(list) })
            .setNegativeButton("Cancel") { _, _ -> status.text = "Sync cancelled. Nothing was uploaded." }
            .setPositiveButton("Sync selected") { _, _ ->
                val chosen = rows.filter { it.check.isEnabled && it.check.isChecked }
                    .map { it.record.copy(activityType = it.type.selectedItem as String) }
                upload(token, option, chosen)
            }
            .create()
        dialog.show()
    }

    private fun upload(token: String, option: TeamOption, records: List<HealthRecord>) {
        if (records.isEmpty()) {
            status.text = "Nothing selected, so nothing was uploaded."
            return
        }
        lifecycleScope.launch {
            status.text = "Uploading ${records.size} workout(s)..."
            runCatching { withContext(Dispatchers.IO) { api().importHealth(token, records) } }
                .onSuccess {
                    status.text = "Sync complete. Added ${it.added}" + (if (it.skipped > 0) ", skipped ${it.skipped}" else "") + "." +
                        if (option.measuresDistance && it.skipped > 0) " Workouts with no recorded distance don't count in a distance challenge." else ""
                }
                .onFailure {
                    if (it is ApiException && it.status == 401) {
                        prefs.edit().remove("token").apply()
                        showSignedOut("Your session has expired. Please sign in again, then sync.")
                    } else {
                        status.text = "Sync failed: ${it.message}"
                    }
                }
        }
    }

    /** e.g. "Tue 14 Oct, 07:00–07:42 · 42 min · 3.1 mi" */
    private fun describe(r: HealthRecord, option: TeamOption): String {
        val parts = mutableListOf("${fmtDay(LocalDate.parse(r.activityDate))}, ${r.startTime}–${r.endTime}", "${r.minutes} min")
        r.distanceMeters?.let { m ->
            val v = if (option.distanceUnit == "km") m / 1000 else m / 1609.344
            parts.add(String.format(Locale.getDefault(), "%.2f %s", v, option.distanceUnit))
        }
        return parts.joinToString(" · ")
    }

    private fun fmtDay(d: LocalDate): String = d.format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.getDefault()))

    private fun api() = ActiveTogetherApi(SERVER_URL)
}
