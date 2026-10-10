package com.activetogether.companion.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.activetogether.companion.ApiException
import com.activetogether.companion.ChallengeDetail
import com.activetogether.companion.ChallengeMembers
import com.activetogether.companion.Member
import com.activetogether.companion.MemberEntry
import com.activetogether.companion.MyTeam
import com.activetogether.companion.TeamMembers
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val SOURCE_LABEL = mapOf("manual" to "logged by hand", "health_connect" to "Health Connect", "health_kit" to "Apple Health", "shortcut" to "Apple Shortcut")

/** An entry's amount in its challenge's measure: "5,200 steps", "3.1 mi" or "45 min". */
private fun entryAmount(d: ChallengeDetail?, e: MemberEntry) = when {
    d?.measuresSteps == true -> "${fmtSteps(e.steps ?: 0)} steps"
    d?.measuresDistance == true -> "${fmtNum(e.distance ?: 0.0)} ${if (d.distanceUnit == "km") "km" else "mi"}"
    else -> "${fmtNum(e.minutes ?: 0.0)} min"
}

/** A server call whose error shows next to the form (not as a passing message). Returns null and sets [error] on failure. */
private suspend fun <T> AppViewModel.tryInline(onError: (String) -> Unit, block: (com.activetogether.companion.ActiveTogetherApi) -> T): T? = try {
    withContext(Dispatchers.IO) { block(api()) }
} catch (e: ApiException) {
    if (e.status == 401) call<T> { throw e } else onError(e.message ?: "That didn't work"); null
} catch (e: Exception) {
    onError("Couldn't reach Active Together: ${e.message ?: e.javaClass.simpleName}"); null
}

/**
 * A new invite code for a challenge or team: the old link and code stop working straight away. Global admins get a
 * suggested code they can keep or replace with their own (asked again if it's taken or not allowed).
 */
@Composable
fun NewInviteCodeDialog(vm: AppViewModel, team: Boolean, id: Int, what: String, dismiss: () -> Unit, done: (String) -> Unit) {
    val admin = vm.me?.isAdmin == true
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    if (admin) LaunchedEffect(Unit) { vm.tryInline({ error = it }) { it.suggestInviteCode() }?.let { if (code.isEmpty()) code = it } }
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text(if (admin) "New invite code" else "Make a new invite link?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("The current link and code for $what stop working straight away; people already in aren't affected.")
                if (admin) {
                    OutlinedTextField(code, { code = it.uppercase().filter { c -> c.isLetterOrDigit() }.take(20); error = null }, label = { Text("Code") },
                        supportingText = { Text("Keep this one or type your own: 6 to 20 letters and numbers.") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false), modifier = Modifier.fillMaxWidth())
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && (!admin || code.length >= 6), onClick = {
                busy = true
                scope.launch {
                    vm.tryInline({ error = it }) { it.newInviteCode(team, id, if (admin) code else null) }?.let { done(it) }
                    busy = false
                }
            }) { Text(if (admin) "Use this code" else "Make a new link") }
        },
        dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } },
    )
}

/** Owners (and global admins): everyone in a challenge, adding people by email, their entries, and removing them. */
@Composable
fun ChallengeMembersScreen(vm: AppViewModel, challengeId: Int) {
    val scope = rememberCoroutineScope()
    val detail = vm.details[challengeId]
    var data by remember { mutableStateOf<ChallengeMembers?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var email by remember { mutableStateOf("") }
    var team by remember { mutableStateOf<MyTeam?>(null) }
    var owner by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<Member?>(null) }
    var openEntries by remember { mutableStateOf<Int?>(null) }
    var entries by remember { mutableStateOf<List<MemberEntry>?>(null) }
    var deleting by remember { mutableStateOf<MemberEntry?>(null) }
    val meId = vm.me?.id
    val admin = vm.me?.isAdmin == true
    suspend fun reload(msg: String? = null) {
        vm.tryInline({ error = it }) { it.challengeMembers(challengeId) }?.let { data = it }
        if (msg != null) { note = msg; error = null }
    }
    suspend fun loadEntries(uid: Int) { entries = null; entries = vm.tryInline({ error = it }) { it.memberEntries(challengeId, uid) } ?: emptyList() }
    LaunchedEffect(challengeId) { if (detail == null) vm.loadDetail(challengeId); reload() }
    val d = data ?: run { Loading(); return }
    val individual = detail?.individual ?: d.teams.isEmpty()

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            SectionCard("Add someone") {
                OutlinedTextField(email, { email = it; error = null }, label = { Text("Their email") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false), modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (!individual) Dropdown("Team", listOf<MyTeam?>(null) + d.teams, team, { it?.name ?: "No team yet" }, { team = it }, Modifier.weight(1f))
                    Dropdown("Role", listOf(false, true), owner, { if (it) "Owner" else "Member" }, { owner = it }, Modifier.weight(1f))
                }
                Button(enabled = !busy && email.contains('@'), onClick = {
                    busy = true
                    scope.launch {
                        vm.tryInline({ error = it; note = null }) { it.addMember(challengeId, email, owner, team?.id) }?.let { (added, name) ->
                            email = ""; vm.afterManage(challengeId)
                            reload(if (added) "Added $name. They've been told." else "$name was already in; their team and role are updated.")
                        }
                        busy = false
                    }
                }) { Icon(Icons.Default.PersonAdd, null); Spacer(Modifier.width(6.dp)); Text("Add to challenge") }
                EmptyNote("Anyone with an account. They're told, and can leave if they didn't expect it. No account yet? Share the invite link.")
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                note?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
            }
        }
        item {
            Text("${d.members.size} ${if (d.members.size == 1) "member" else "members"}" + if (individual) " · individuals" else " · ${d.teams.size} ${if (d.teams.size == 1) "team" else "teams"}",
                style = MaterialTheme.typography.titleMedium)
        }
        items(d.members, key = { it.id }) { m ->
            SectionCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Avatar(m.avatarUrl, m.name)
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(m.name + if (m.id == meId) " (you)" else "", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.clickable { vm.openProfile(m.id) })
                        Text(listOfNotNull(m.email, if (m.role == "owner") "owner" else "member", m.teams ?: if (individual) null else "no team",
                            "${m.entries} ${if (m.entries == 1) "entry" else "entries"}", if (m.deactivated) "deactivated" else null).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (m.entries > 0) OutlinedButton(onClick = {
                        if (openEntries == m.id) openEntries = null else { openEntries = m.id; scope.launch { loadEntries(m.id) } }
                    }) { Text(if (openEntries == m.id) "Hide entries" else "Entries") }
                    if (m.id != meId || admin) TextButton(onClick = { removing = m }) { Text("Remove") }
                }
                if (openEntries == m.id) {
                    val list = entries
                    if (list == null) Loading(Modifier.padding(4.dp))
                    else if (list.isEmpty()) EmptyNote("No entries.")
                    else list.forEachIndexed { i, e ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("${e.type} · ${entryAmount(detail, e)}", style = MaterialTheme.typography.bodyLarge)
                                Text(listOfNotNull(fmtDay(e.date), e.startTime, e.teamName, SOURCE_LABEL[e.source] ?: e.source, e.comment?.let { "“$it”" }).joinToString(" · "),
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            TextButton(onClick = { deleting = e }) { Icon(Icons.Default.Delete, "Delete entry") }
                        }
                        if (i < list.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    }
                }
            }
        }
    }
    removing?.let { m ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove ${m.name}?") },
            text = { Text("They're taken out of the challenge and its teams, and everything they logged in it is deleted. They'd need the invite link to come back.") },
            confirmButton = { TextButton(onClick = {
                removing = null
                scope.launch { if (vm.tryInline({ error = it }) { it.removeMember(challengeId, m.id) } != null) { vm.afterManage(challengeId); reload("Removed ${m.name}.") } }
            }) { Text("Remove", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
    deleting?.let { e ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete this entry?") },
            text = { Text("It stops counting straight away, and the person can't undo it.") },
            confirmButton = { TextButton(onClick = {
                deleting = null
                scope.launch {
                    if (vm.tryInline({ error = it }) { it.deleteActivity(e.id) } != null) {
                        vm.afterManage(challengeId); reload("Entry deleted."); openEntries?.let { loadEntries(it) }
                    }
                }
            }) { Text("Delete entry", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

/** A team admin, the challenge's owners or a global admin: rename the team, its people, its invite code, or delete it. */
@Composable
fun TeamManageScreen(vm: AppViewModel, challengeId: Int, teamId: Int, gone: () -> Unit) {
    val scope = rememberCoroutineScope()
    val detail = vm.details[challengeId]
    val team = detail?.teams?.firstOrNull { it.id == teamId }
    var data by remember { mutableStateOf<TeamMembers?>(null) }
    var name by remember(team?.name) { mutableStateOf(team?.name ?: "") }
    var email by remember { mutableStateOf("") }
    var note by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<com.activetogether.companion.TeamMember?>(null) }
    var newCode by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    suspend fun reload(msg: String? = null) {
        vm.tryInline({ error = it }) { it.teamMembers(teamId) }?.let { data = it }
        if (msg != null) { note = msg; error = null }
    }
    LaunchedEffect(teamId) { if (detail == null) vm.loadDetail(challengeId); reload() }
    val d = data ?: run { Loading(); return }
    val owner = detail?.canManage == true

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            SectionCard("Team name") {
                OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Button(enabled = !busy && name.isNotBlank() && name.trim() != team?.name, onClick = {
                    busy = true
                    scope.launch {
                        if (vm.tryInline({ error = it; note = null }) { it.renameTeam(teamId, name) } != null) { vm.afterManage(challengeId); note = "Saved."; error = null }
                        busy = false
                    }
                }) { Text("Save name") }
                EmptyNote("The team's logo can be changed on the website.")
            }
        }
        item {
            SectionCard("Invite code") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(team?.inviteCode ?: "", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
                    TextButton(onClick = { newCode = true }) { Text("New code") }
                }
                EmptyNote("Anyone with the team's link or code joins the challenge and this team.")
            }
        }
        item {
            SectionCard("Members") {
                if (d.members.isEmpty()) EmptyNote("No members.")
                d.members.forEachIndexed { i, m ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(m.name, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.clickable { vm.openProfile(m.id) })
                            Text(listOfNotNull(m.email, if (m.role == "team_admin") "team admin" else "member").joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        TextButton(onClick = { removing = m }) { Text("Remove") }
                    }
                    if (i < d.members.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                }
                OutlinedTextField(email, { email = it; error = null }, label = { Text(if (owner) "Add someone by email" else "Add someone already in this challenge (their email)") },
                    singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false), modifier = Modifier.fillMaxWidth())
                Button(enabled = !busy && email.contains('@'), onClick = {
                    busy = true
                    scope.launch {
                        vm.tryInline({ error = it; note = null }) { it.addTeamMember(teamId, email) }?.let { who -> email = ""; vm.afterManage(challengeId); reload("Added $who.") }
                        busy = false
                    }
                }) { Text("Add to team") }
                EmptyNote(if (owner) "Anyone with an account: they're added to the challenge too, and told." else "To bring someone new in, share the team's invite code.")
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                note?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
            }
        }
        item {
            OutlinedButton(onClick = { deleting = true }, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Default.Delete, null, tint = MaterialTheme.colorScheme.error); Spacer(Modifier.width(8.dp)); Text("Delete this team", color = MaterialTheme.colorScheme.error)
            }
        }
    }
    if (newCode) NewInviteCodeDialog(vm, team = true, id = teamId, what = "the team \"${team?.name ?: name}\"", dismiss = { newCode = false }) { code ->
        newCode = false; scope.launch { vm.afterManage(challengeId); note = "New code: $code"; error = null }
    }
    removing?.let { m ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove ${m.name} from the team?") },
            text = { Text("What they logged under it stays on the team total. They stay in the challenge.") },
            confirmButton = { TextButton(onClick = {
                removing = null
                scope.launch { if (vm.tryInline({ error = it }) { it.removeTeamMember(teamId, m.id) } != null) { vm.afterManage(challengeId); reload("Removed ${m.name}.") } }
            }) { Text("Remove") } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
    if (deleting) {
        AlertDialog(
            onDismissRequest = { deleting = false },
            title = { Text("Delete ${team?.name ?: "this team"}?") },
            text = { Text("This removes its members and any activity logged under it. This cannot be undone.") },
            confirmButton = { TextButton(onClick = {
                deleting = false
                scope.launch { if (vm.tryInline({ error = it }) { it.deleteTeam(teamId) } != null) { vm.afterManage(challengeId); vm.message = "Team deleted"; gone() } }
            }) { Text("Delete team", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { deleting = false }) { Text("Cancel") } },
        )
    }
}
