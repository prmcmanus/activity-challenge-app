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
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.activetogether.companion.AdminChallenge
import com.activetogether.companion.AdminUser
import kotlinx.coroutines.launch

private val STATES = listOf("" to "All", "running" to "Running", "upcoming" to "Not started", "finished" to "Finished")
private fun plural(n: Int, one: String, many: String) = "$n ${if (n == 1) one else many}"

/** Global admins: every user and every challenge on the site, whether or not they're in it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AdminScreen(vm: AppViewModel, openChallenge: (Int) -> Unit) {
    val scope = rememberCoroutineScope()
    var tab by rememberSaveable { mutableStateOf(0) }
    var query by rememberSaveable { mutableStateOf("") }
    var stateFilter by rememberSaveable { mutableStateOf("") }
    var users by remember { mutableStateOf<List<AdminUser>?>(null) }
    var challenges by remember { mutableStateOf<List<AdminChallenge>?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<AdminUser?>(null) }
    var creating by remember { mutableStateOf(false) }

    suspend fun load() {
        vm.call { it.adminUsers() }?.let { users = it }
        vm.call { it.adminChallenges() }?.let { challenges = it }
    }
    LaunchedEffect(Unit) { load() }

    PullToRefreshBox(isRefreshing = refreshing, onRefresh = { scope.launch { refreshing = true; load(); refreshing = false } }, modifier = Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Hero("Administration", "Users and challenges", below = {
                Text("Everything on the site, whether or not you've joined it.", color = androidx.compose.ui.graphics.Color.White.copy(alpha = 0.9f),
                    style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 4.dp))
            }) }
            item {
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    SegmentedButton(tab == 0, { tab = 0 }, SegmentedButtonDefaults.itemShape(0, 2)) { Text("Users" + (users?.let { " (${it.size})" } ?: "")) }
                    SegmentedButton(tab == 1, { tab = 1 }, SegmentedButtonDefaults.itemShape(1, 2)) { Text("Challenges" + (challenges?.let { " (${it.size})" } ?: "")) }
                }
            }
            item {
                OutlinedTextField(query, { query = it }, label = { Text(if (tab == 0) "Search name or email" else "Search name, owner or code") },
                    leadingIcon = { Icon(Icons.Default.Search, null) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            }
            val q = query.trim().lowercase()
            if (tab == 0) {
                item {
                    OutlinedButton(onClick = { creating = true }, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.PersonAdd, null); Spacer(Modifier.width(8.dp)); Text("New user") }
                }
                val list = users
                if (list == null) item { Loading() }
                else {
                    val rows = list.filter { q.isEmpty() || "${it.name} ${it.email}".lowercase().contains(q) }
                    if (rows.isEmpty()) item { SectionCard { EmptyNote("No users match.") } }
                    items(rows, key = { it.id }) { u -> UserCard(u, isMe = u.id == vm.me?.id) { editing = u } }
                }
            } else {
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        STATES.forEach { (k, label) ->
                            AssistChip(onClick = { stateFilter = k }, label = { Text(label, maxLines = 1) },
                                colors = AssistChipDefaults.assistChipColors(containerColor = if (stateFilter == k) MaterialTheme.colorScheme.secondaryContainer else androidx.compose.ui.graphics.Color.Transparent))
                        }
                    }
                }
                val list = challenges
                if (list == null) item { Loading() }
                else {
                    val rows = list.filter { (stateFilter.isEmpty() || it.state == stateFilter) && (q.isEmpty() || "${it.name} ${it.owners.orEmpty()} ${it.inviteCode}".lowercase().contains(q)) }
                    if (rows.isEmpty()) item { SectionCard { EmptyNote("No challenges match.") } }
                    items(rows, key = { it.id }) { c -> ChallengeAdminCard(c) { openChallenge(c.id) } }
                }
            }
        }
    }

    if (creating || editing != null) {
        val target = editing
        UserDialog(existing = target, isMe = target != null && target.id == vm.me?.id, onDismiss = { creating = false; editing = null },
            setActive = { active ->
                if (target != null && vm.call { it.adminSetActive(target.id, active) } != null) {
                    vm.message = if (active) "${target.name} reactivated" else "${target.name} deactivated"; editing = null; load()
                }
            },
            delete = {
                if (target != null && vm.call { it.adminDeleteUser(target.id) } != null) { vm.message = "${target.name} deleted"; editing = null; load() }
            }) { name, email, role, password ->
            val target = editing
            val ok = if (target == null) vm.call { it.adminCreateUser(name, email, role, password) } != null
                     else vm.call { it.adminUpdateUser(target.id, name, email, role, password) } != null
            if (ok) {
                vm.message = if (target == null) "User created" else "Saved"
                creating = false; editing = null
                load()
                if (target?.id == vm.me?.id) vm.refreshMe()
            }
            ok
        }
    }
}

@Composable
private fun UserCard(u: AdminUser, isMe: Boolean, edit: () -> Unit) {
    SectionCard(modifier = Modifier.clickable(onClick = edit)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Avatar(u.avatarUrl, u.name)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(u.name + if (isMe) " (you)" else "", style = MaterialTheme.typography.titleMedium)
                Text(u.email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Column(horizontalAlignment = Alignment.End) {
                RolePill(if (u.isAdmin) "Global admin" else "Member", u.isAdmin)
                if (u.deactivatedAt != null) Text("Deactivated", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
            }
        }
        Text(listOfNotNull(plural(u.challenges, "challenge", "challenges"), plural(u.activities, "activity", "activities"),
            u.lastActivity?.let { "last active $it" } ?: "no activity yet", if (u.tickets > 0) plural(u.tickets, "ticket", "tickets") else null,
            "joined ${u.createdAt}").joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun RolePill(label: String, strong: Boolean) {
    AssistChip(onClick = {}, enabled = true, label = { Text(label, maxLines = 1) },
        colors = AssistChipDefaults.assistChipColors(containerColor = if (strong) MaterialTheme.colorScheme.primaryContainer else androidx.compose.ui.graphics.Color.Transparent))
}

@Composable
private fun ChallengeAdminCard(c: AdminChallenge, open: () -> Unit) {
    SectionCard(modifier = Modifier.clickable(onClick = open)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(c.name, style = MaterialTheme.typography.titleMedium)
                Text(fmtRange(c.startDate, c.endDate), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            RolePill(STATES.first { it.first == c.state }.second, c.state == "running")
            Icon(Icons.Default.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(listOfNotNull(
            if (c.measuresDistance) "Distance (${if (c.distanceUnit == "km") "km" else "miles"})" else "Active minutes",
            if (c.individual) "Individuals" else plural(c.teams, "team", "teams"),
            plural(c.members, "member", "members"), plural(c.activities, "activity", "activities"),
            "owner: ${c.owners ?: "none"}", "code ${c.inviteCode}",
            if (c.state == "finished") "deleted on ${c.purgeDate}" else null,
        ).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Create (existing == null) or edit an account. save returns true when it worked, to close the dialog. */
@Composable
private fun UserDialog(existing: AdminUser?, isMe: Boolean, onDismiss: () -> Unit, setActive: suspend (Boolean) -> Unit, delete: suspend () -> Unit,
                       save: suspend (String, String, String, String) -> Boolean) {
    var confirmDelete by remember { mutableStateOf(false) }
    if (confirmDelete && existing != null) {
        DeleteUserDialog(existing, onDismiss = { confirmDelete = false }, delete = delete)
        return
    }
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf(existing?.name.orEmpty()) }
    var email by remember { mutableStateOf(existing?.email.orEmpty()) }
    var role by remember { mutableStateOf(existing?.role ?: "member") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val passwordOk = if (existing == null) password.length >= 8 else password.isEmpty() || password.length >= 8
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (existing == null) "New user" else "Edit ${existing.name}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true)
                OutlinedTextField(email, { email = it.trim() }, label = { Text("Email") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
                Dropdown("Role", listOf("member", "global_admin"), role, { if (it == "global_admin") "Global admin" else "Member" }, { role = it })
                OutlinedTextField(password, { password = it }, singleLine = true, visualTransformation = PasswordVisualTransformation(),
                    label = { Text(if (existing == null) "Temporary password" else "Reset password (optional)") },
                    supportingText = { Text(if (existing == null) "At least 8 characters. Share it with them to sign in." else "Leave blank to keep theirs. Setting one signs them out everywhere.") })
                if (existing != null && !isMe) {
                    HorizontalDivider()
                    Text(if (existing.deactivatedAt != null) "Deactivated ${existing.deactivatedAt}. They can't sign in; their activity still counts."
                         else "Deactivating signs them out and stops them signing in. Their activity stays on the leaderboards.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(enabled = !busy, onClick = { busy = true; scope.launch { setActive(existing.deactivatedAt != null); busy = false } }) {
                            Text(if (existing.deactivatedAt != null) "Reactivate" else "Deactivate")
                        }
                        OutlinedButton(enabled = !busy, onClick = { confirmDelete = true },
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Delete") }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && name.isNotBlank() && email.contains('@') && passwordOk, onClick = {
                busy = true; scope.launch { save(name.trim(), email, role, password); busy = false }
            }) { Text(if (existing == null) "Create" else "Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Deleting is for good, so the email has to be typed to confirm. */
@Composable
private fun DeleteUserDialog(u: AdminUser, onDismiss: () -> Unit, delete: suspend () -> Unit) {
    val scope = rememberCoroutineScope()
    var typed by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Delete ${u.name}?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("This permanently removes the account with all their activity, routes, team memberships and tickets. Challenges and teams they created stay, credited to you. Type their email to confirm.")
                OutlinedTextField(typed, { typed = it.trim() }, label = { Text("Their email") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && typed.equals(u.email, ignoreCase = true), onClick = { busy = true; scope.launch { delete(); busy = false } }) {
                Text("Delete for good", color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
