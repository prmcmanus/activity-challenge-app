package com.activetogether.companion.ui

import android.app.DatePickerDialog
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.activetogether.companion.ChallengeDetail
import com.activetogether.companion.ChallengeFields
import com.activetogether.companion.SERVER_URL
import kotlinx.coroutines.launch
import java.time.LocalDate

/** Plain text from the form as the simple HTML the web editor stores: one paragraph per line. */
private fun textToHtml(text: String): String = text.trim().lines().filter { it.isNotBlank() }.joinToString("") { line ->
    "<p>" + line.trim().replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;") + "</p>"
}

/** Share a challenge's invite code through any app (messages, email, chat). */
fun shareInvite(context: Context, name: String, code: String) {
    val text = "Join my challenge \"$name\" on Active Together: $SERVER_URL/join/$code (or use invite code $code)"
    context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "Share invite"))
}

@Composable
private fun DateButton(label: String, date: LocalDate, modifier: Modifier = Modifier, onPick: (LocalDate) -> Unit) {
    val context = LocalContext.current
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedButton(onClick = {
            DatePickerDialog(context, { _, y, m, d -> onPick(LocalDate.of(y, m + 1, d)) }, date.year, date.monthValue - 1, date.dayOfMonth).show()
        }, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.CalendarMonth, null); Spacer(Modifier.width(6.dp)); Text(fmtDay(date) + " " + date.year, maxLines = 1) }
    }
}

/**
 * New challenge (existing == null) or edit one I own. Created challenges open straight away with
 * their invite code ready to share. Editing an owner's challenge can also delete it.
 */
@Composable
fun ChallengeFormScreen(vm: AppViewModel, challengeId: Int?, done: (Int?) -> Unit) {
    if (challengeId != null) {
        LaunchedEffect(challengeId) { if (vm.details[challengeId] == null) vm.loadDetail(challengeId) }
        val d = vm.details[challengeId] ?: run { Loading(); return }
        ChallengeForm(vm, d, done)
    } else ChallengeForm(vm, null, done)
}

@Composable
private fun ChallengeForm(vm: AppViewModel, existing: ChallengeDetail?, done: (Int?) -> Unit) {
    val scope = rememberCoroutineScope()
    val today = LocalDate.now()
    val originalDescription = remember { existing?.descriptionHtml?.let { htmlToText(it) }.orEmpty() }
    var name by remember { mutableStateOf(existing?.name.orEmpty()) }
    var description by remember { mutableStateOf(originalDescription) }
    var start by remember { mutableStateOf(existing?.startDate ?: today) }
    var end by remember { mutableStateOf(existing?.endDate ?: today.plusDays(29)) }
    // "minutes", "distance" or "steps"
    var measure by remember { mutableStateOf(when { existing?.measuresSteps == true -> "steps"; existing?.measuresDistance == true -> "distance"; else -> "minutes" }) }
    val distance = measure == "distance"
    var unit by remember { mutableStateOf(existing?.distanceUnit ?: vm.prefs.preferredUnit) }
    var individual by remember { mutableStateOf(existing?.individual ?: false) }
    var firstTeam by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var deleting by remember { mutableStateOf(false) }

    fun save() {
        error = when {
            name.isBlank() -> "Give the challenge a name."
            end.isBefore(start) -> "The end date is before the start date."
            else -> null
        }
        if (error != null) return
        // The web editor allows formatting; only replace the description when it was actually edited here.
        val desc = if (existing == null) textToHtml(description).ifBlank { null } else if (description.trim() != originalDescription) textToHtml(description) else null
        val f = ChallengeFields(name.trim(), desc, start, end, distance, unit, individual, measure == "steps")
        busy = true
        scope.launch {
            val id = if (existing == null) vm.createChallenge(f, firstTeam) else if (vm.updateChallenge(existing.id, f)) existing.id else null
            busy = false
            if (id != null) done(id)
        }
    }

    Column(Modifier.verticalScroll(rememberScrollState()).padding(PagePadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionCard(if (existing == null) "New challenge" else null) {
            OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences))
            OutlinedTextField(description, { description = it }, label = { Text("Description (optional)") }, minLines = 3, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                supportingText = if (existing != null && existing.descriptionHtml.contains("<(b|i|strong|em|ul|ol|a)\\b".toRegex())) {
                    { Text("Editing here replaces any bold, lists or links set on the website.") }
                } else null)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                DateButton("Starts", start, Modifier.weight(1f)) { start = it; if (end.isBefore(it)) end = it }
                DateButton("Ends", end, Modifier.weight(1f)) { end = it }
            }
        }
        SectionCard("How it works") {
            Dropdown("Measure", listOf("minutes", "distance", "steps"), measure, { when (it) { "distance" -> "Distance"; "steps" -> "Steps"; else -> "Active minutes" } }, { measure = it })
            if (measure == "steps") Text("Everyone's daily step total counts. The app fills it in from the phone, or people enter it by hand.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (distance) Dropdown("Distance unit", listOf("mi", "km"), unit, { if (it == "km") "Kilometres" else "Miles" }, { unit = it })
            Dropdown("Who takes part", listOf(false, true), individual, { if (it) "Individuals only" else "Teams" }, { individual = it })
            Text(if (individual) "Everyone logs straight to the challenge; there are no teams." else "People join a team and the teams compete, as well as individuals.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (existing != null && (existing.measuresDistance != distance || existing.measuresSteps != (measure == "steps")))
                Text("Changing the measure re-ranks the leaderboards. Entries logged without that measure count as zero toward it.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            if (existing == null && !individual)
                OutlinedTextField(firstTeam, { firstTeam = it }, label = { Text("Your team's name (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    supportingText = { Text("Creates the first team with you in it. Others can create their own.") })
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(onClick = { save() }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
            Text(if (busy) "Saving..." else if (existing == null) "Create challenge" else "Save changes")
        }
        if (existing != null) {
            SectionCard("Delete challenge") {
                Text("Permanently deletes this challenge with all its teams, members and logged activity, for everyone. This can't be undone.",
                    style = MaterialTheme.typography.bodyMedium)
                OutlinedButton(onClick = { deleting = true }, colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) {
                    Text("Delete challenge")
                }
            }
        }
    }

    if (deleting && existing != null) {
        var typed by remember { mutableStateOf("") }
        val matches = typed.trim() == existing.name.trim()
        AlertDialog(
            onDismissRequest = { deleting = false },
            title = { Text("Delete \"${existing.name}\"?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Everything logged in it is deleted for every member. Type the challenge name to confirm.")
                    OutlinedTextField(typed, { typed = it }, singleLine = true, label = { Text("Challenge name") })
                }
            },
            confirmButton = {
                TextButton(enabled = matches, onClick = { deleting = false; scope.launch { if (vm.deleteChallenge(existing.id)) done(null) } }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleting = false }) { Text("Cancel") } },
        )
    }
}

/** Join a challenge (or a team in one) with the code someone shared. */
@Composable
fun JoinScreen(vm: AppViewModel, joined: (Int) -> Unit) {
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    Column(Modifier.padding(PagePadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionCard("Join with an invite code") {
            Text("Enter the code from a challenge or team invite. A team code also puts you in that team.", style = MaterialTheme.typography.bodyMedium)
            OutlinedTextField(code, { code = it.uppercase().filter { ch -> ch.isLetterOrDigit() } }, label = { Text("Invite code") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters))
            Button(onClick = { busy = true; scope.launch { val id = vm.join(code); busy = false; if (id != null) joined(id) } },
                enabled = code.length >= 4 && !busy, modifier = Modifier.fillMaxWidth()) { Text(if (busy) "Joining..." else "Join") }
        }
    }
}
