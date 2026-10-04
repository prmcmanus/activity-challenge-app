package com.activetogether.companion.ui

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.automirrored.filled.DirectionsRun
import androidx.compose.material.icons.filled.Map
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.activetogether.companion.Challenge
import com.activetogether.companion.MyActivity
import com.activetogether.companion.RoutePoint
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/** "3.1 mi · 28 min" - the challenge's own measure first. */
fun fmtEntry(a: MyActivity): String {
    if (a.steps != null && (a.measuresSteps || (a.minutes == null && a.distance == null))) return "${fmtSteps(a.steps)} steps"
    val d = a.distance?.let { "${fmtNum(it)} ${if (a.distanceUnit == "km") "km" else "mi"}" }
    val m = a.minutes?.let { "${fmtNum(it)} min" }
    return (if (a.measuresDistance) listOf(d, m) else listOf(m, d)).filterNotNull().joinToString(" · ")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActivityListScreen(vm: AppViewModel, open: (MyActivity) -> Unit) {
    PullToRefreshBox(modifier = Modifier.fillMaxSize(), isRefreshing = vm.topRefreshing, onRefresh = { vm.refreshTop() }) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { Text("My activity", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 4.dp)) }
            if (vm.activities.isEmpty() && !vm.loadingActivities) {
                item { SectionCard { EmptyNote("Nothing logged yet. Tap + to log an activity, or sync your workouts from the Sync tab.") } }
            }
            // One card per workout: entries for the same workout in several challenges are listed under it.
            val groups = vm.activities.groupBy { listOf(it.date, it.type, it.startTime, it.minutes, it.source, it.comment) }
            items(groups.values.toList(), key = { it.first().id }) { entries ->
                val a = entries.first()
                SectionCard(modifier = Modifier.clickable { open(a) }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(42.dp).clip(MaterialTheme.shapes.medium), contentAlignment = Alignment.Center) {
                            Icon(if (a.hasRoute) Icons.Default.Map else Icons.AutoMirrored.Filled.DirectionsRun, null, tint = MaterialTheme.colorScheme.primary)
                        }
                        Spacer(Modifier.width(8.dp))
                        Column(Modifier.weight(1f)) {
                            Text(a.type, style = MaterialTheme.typography.titleMedium)
                            Text(listOfNotNull(fmtDay(a.date), a.startTime).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text(fmtEntry(a), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    }
                    Text(entries.joinToString(" · ") { e -> e.challengeName + (e.teamName?.let { " ($it)" } ?: "") },
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (vm.moreActivities) {
                item { OutlinedButton(onClick = { vm.loadActivities(reset = false) }, modifier = Modifier.fillMaxWidth()) { Text("Show more") } }
            }
        }
    }
}

/** Entries for the same workout in other challenges - matched on what a workout is, since each challenge has its own entry. */
fun siblingsOf(vm: AppViewModel, a: MyActivity) = vm.activities.filter {
    it.date == a.date && it.type == a.type && it.startTime == a.startTime && it.minutes == a.minutes && it.source == a.source && it.comment == a.comment
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActivityDetailScreen(vm: AppViewModel, activityId: Int, back: () -> Unit, edit: () -> Unit) {
    val a = vm.activities.firstOrNull { it.id == activityId } ?: run { Loading(); return }
    val siblings = siblingsOf(vm, a)
    var route by remember { mutableStateOf<List<RoutePoint>?>(null) }
    var confirm by remember { mutableStateOf<MyActivity?>(null) }
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(activityId) { if (a.hasRoute) route = vm.route(a.id) }

    PullToRefreshBox(modifier = Modifier.fillMaxSize(), isRefreshing = refreshing, onRefresh = { scope.launch { refreshing = true; vm.refreshActivities(); if (a.hasRoute) route = vm.route(a.id); refreshing = false } }) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Hero(listOfNotNull(fmtDay(a.date), a.startTime?.let { s -> a.endTime?.let { "$s–$it" } ?: s }).joinToString(" · "), a.type,
                trailing = { HeroStat(fmtEntry(a).substringBefore(" · ").removeSuffix(" steps"), if (a.measuresSteps) "steps" else if (a.measuresDistance) "distance" else "active") })
        }
        item {
            Button(onClick = edit, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.Edit, null); Spacer(Modifier.width(8.dp)); Text("Edit activity") }
        }
        if (a.hasRoute) {
            item {
                SectionCard("Route") {
                    val pts = route
                    if (pts == null) Loading(Modifier.height(260.dp)) else RouteMap(pts, Modifier.fillMaxWidth().height(320.dp).clip(MaterialTheme.shapes.medium))
                    Text("Only you can see your route.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        item {
            SectionCard("Logged in") {
                siblings.forEach { e ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(e.challengeName, style = MaterialTheme.typography.titleMedium)
                            Text(listOfNotNull(e.teamName, fmtEntry(e)).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        TextButton(onClick = { confirm = e }) { Icon(Icons.Default.Delete, null); Text("Remove") }
                    }
                }
            }
        }
        a.comment?.takeIf { it.isNotBlank() }?.let { item { SectionCard("Comment") { Text("“$it”") } } }
        item { Text("Source: ${if (a.source == "manual") "logged by hand" else if (a.source == "health_connect") "Health Connect" else a.source}",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
    }

    confirm?.let { e ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("Remove from ${e.challengeName}?") },
            text = { Text("This entry stops counting in that challenge. It stays in any other challenge it was logged into.") },
            confirmButton = { TextButton(onClick = { val last = siblings.size == 1; vm.deleteActivity(e) { if (last) back() }; confirm = null }) { Text("Remove") } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Cancel") } },
        )
    }
}

/** Log an activity by hand into every challenge it should count in. */
@Composable
fun LogActivityScreen(vm: AppViewModel, done: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var type by remember { mutableStateOf("Walking") }
    var date by remember { mutableStateOf(LocalDate.now()) }
    var start by remember { mutableStateOf<LocalTime?>(null) }
    var end by remember { mutableStateOf<LocalTime?>(null) }
    var minutes by remember { mutableStateOf("") }
    var distance by remember { mutableStateOf("") }
    var unit by remember { mutableStateOf(vm.prefs.preferredUnit) }
    var steps by remember { mutableStateOf("") }
    var comment by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val fits: List<Challenge> = vm.challenges.filter { it.contains(date) && it.target != null }
    val chosen = remember { mutableStateListOf<Int>() }
    // Every challenge the date falls in is ticked by default, as it changes.
    LaunchedEffect(date, vm.challenges) { chosen.clear(); chosen.addAll(fits.map { it.id }) }
    LaunchedEffect(fits.firstOrNull { it.measuresDistance }?.distanceUnit) { fits.firstOrNull { it.measuresDistance }?.let { unit = it.distanceUnit } }

    val hhmm = DateTimeFormatter.ofPattern("HH:mm")
    // Start and finish fill in the minutes, as on the web form.
    fun recalc() { val s = start; val e = end; if (s != null && e != null && e.isAfter(s)) minutes = java.time.Duration.between(s, e).toMinutes().toString() }

    Column(Modifier.verticalScroll(rememberScrollState()).padding(PagePadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionCard {
            Dropdown("Activity", ACTIVITY_TYPES_UI, type, { it }, { type = it })
            OutlinedButton(onClick = {
                DatePickerDialog(context, { _, y, m, d -> date = LocalDate.of(y, m + 1, d) }, date.year, date.monthValue - 1, date.dayOfMonth).show()
            }, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.CalendarMonth, null); Spacer(Modifier.width(8.dp)); Text(fmtDay(date) + " " + date.year) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { val t = start ?: LocalTime.of(7, 0); TimePickerDialog(context, { _, h, mm -> start = LocalTime.of(h, mm); recalc() }, t.hour, t.minute, true).show() },
                    modifier = Modifier.weight(1f)) { Icon(Icons.Default.Schedule, null); Spacer(Modifier.width(6.dp)); Text(start?.format(hhmm) ?: "Start (optional)") }
                OutlinedButton(onClick = { val t = end ?: (start?.plusMinutes(30) ?: LocalTime.of(7, 30)); TimePickerDialog(context, { _, h, mm -> end = LocalTime.of(h, mm); recalc() }, t.hour, t.minute, true).show() },
                    modifier = Modifier.weight(1f)) { Icon(Icons.Default.Schedule, null); Spacer(Modifier.width(6.dp)); Text(end?.format(hhmm) ?: "Finish (optional)") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(distance, { distance = it }, label = { Text("Distance") }, singleLine = true, modifier = Modifier.weight(1f),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                Dropdown("Unit", listOf("mi", "km"), unit, { if (it == "km") "km" else "miles" }, { unit = it }, Modifier.width(130.dp))
            }
            OutlinedTextField(minutes, { minutes = it.filter { ch -> ch.isDigit() } }, label = { Text("Minutes") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
            if (fits.any { it.measuresSteps }) OutlinedTextField(steps, { steps = it.filter { ch -> ch.isDigit() }.take(6) }, label = { Text("Steps that day") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                supportingText = { Text("For step challenges. Syncing fills this in from your phone each day.") })
            OutlinedTextField(comment, { comment = it.take(500) }, label = { Text("Comment (optional)") }, modifier = Modifier.fillMaxWidth())
        }
        SectionCard("Count it in") {
            if (fits.isEmpty()) EmptyNote("None of your challenges run on ${fmtDay(date)}.")
            fits.forEach { c ->
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { if (c.id in chosen) chosen.remove(c.id) else chosen.add(c.id) }) {
                    Checkbox(checked = c.id in chosen, onCheckedChange = { if (it) chosen.add(c.id) else chosen.remove(c.id) })
                    Column(Modifier.weight(1f)) {
                        Text(c.name, style = MaterialTheme.typography.titleMedium)
                        Text((if (c.measuresSteps) "Needs steps" else if (c.measuresDistance) "Needs a distance" else "Needs minutes") + (if (c.individual) "" else " · ${c.myTeams.first().name}"),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            enabled = !busy && chosen.isNotEmpty(),
            modifier = Modifier.fillMaxWidth(),
            onClick = {
                busy = true; error = null
                val targets = fits.filter { it.id in chosen }
                val dist = distance.trim().replace(',', '.').toDoubleOrNull()?.takeIf { it > 0 }
                val mins = minutes.toIntOrNull()?.takeIf { it > 0 }
                val stepCount = steps.toIntOrNull()?.takeIf { it > 0 }
                scope.launch {
                    val n = vm.call { it.logActivity(targets.mapNotNull { c -> c.target }, type, date, mins, dist, unit, start?.format(hhmm), end?.format(hhmm), comment, stepCount) }
                    busy = false
                    if (n != null) { vm.message = "Logged in $n challenge${if (n == 1) "" else "s"}"; vm.afterChange(); done() }
                    else { error = vm.message; vm.message = null }
                }
            },
        ) { Text(if (chosen.size > 1) "Log in ${chosen.size} challenges" else "Log activity") }
    }
}

/** Edit a workout: the same fields as logging, saved to every challenge it's logged in. */
@Composable
fun EditActivityScreen(vm: AppViewModel, activityId: Int, done: () -> Unit) {
    val a = vm.activities.firstOrNull { it.id == activityId } ?: run { Loading(); return }
    if (a.measuresSteps) { EditStepsContent(vm, a, done); return }
    val entries = remember(activityId) { siblingsOf(vm, a) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val hhmm = DateTimeFormatter.ofPattern("HH:mm")
    var type by remember { mutableStateOf(a.type) }
    var date by remember { mutableStateOf(a.date) }
    var start by remember { mutableStateOf(a.startTime?.let { runCatching { LocalTime.parse(it) }.getOrNull() }) }
    var end by remember { mutableStateOf(a.endTime?.let { runCatching { LocalTime.parse(it) }.getOrNull() }) }
    var minutes by remember { mutableStateOf(a.minutes?.let { fmtNum(it) } ?: "") }
    var unit by remember { mutableStateOf(a.distanceUnit) }
    var distance by remember { mutableStateOf(a.distance?.let { fmtNum(it).replace(',', '.') } ?: "") }
    var comment by remember { mutableStateOf(a.comment.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    fun recalc() { val s = start; val e = end; if (s != null && e != null && e.isAfter(s)) minutes = java.time.Duration.between(s, e).toMinutes().toString() }
    val types = if (type in ACTIVITY_TYPES_UI) ACTIVITY_TYPES_UI else listOf(type) + ACTIVITY_TYPES_UI

    Column(Modifier.verticalScroll(rememberScrollState()).padding(PagePadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionCard {
            Dropdown("Activity", types, type, { it }, { type = it })
            OutlinedButton(onClick = {
                DatePickerDialog(context, { _, y, m, d -> date = LocalDate.of(y, m + 1, d) }, date.year, date.monthValue - 1, date.dayOfMonth).show()
            }, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.CalendarMonth, null); Spacer(Modifier.width(8.dp)); Text(fmtDay(date) + " " + date.year) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { val t = start ?: LocalTime.of(7, 0); TimePickerDialog(context, { _, h, mm -> start = LocalTime.of(h, mm); recalc() }, t.hour, t.minute, true).show() },
                    modifier = Modifier.weight(1f)) { Icon(Icons.Default.Schedule, null); Spacer(Modifier.width(6.dp)); Text(start?.format(hhmm) ?: "Start") }
                OutlinedButton(onClick = { val t = end ?: (start?.plusMinutes(30) ?: LocalTime.of(7, 30)); TimePickerDialog(context, { _, h, mm -> end = LocalTime.of(h, mm); recalc() }, t.hour, t.minute, true).show() },
                    modifier = Modifier.weight(1f)) { Icon(Icons.Default.Schedule, null); Spacer(Modifier.width(6.dp)); Text(end?.format(hhmm) ?: "Finish") }
            }
            if (start != null || end != null) TextButton(onClick = { start = null; end = null }) { Text("Clear times") }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(distance, { distance = it }, label = { Text("Distance") }, singleLine = true, modifier = Modifier.weight(1f),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                Dropdown("Unit", listOf("mi", "km"), unit, { if (it == "km") "km" else "miles" }, { unit = it }, Modifier.width(130.dp))
            }
            OutlinedTextField(minutes, { minutes = it.filter { ch -> ch.isDigit() } }, label = { Text("Minutes") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
            OutlinedTextField(comment, { comment = it.take(500) }, label = { Text("Comment (optional)") }, modifier = Modifier.fillMaxWidth())
        }
        if (entries.size > 1) {
            Text("Saved in all ${entries.size} challenges this is logged in: ${entries.joinToString { it.challengeName }}.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Button(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = {
            busy = true
            scope.launch {
                val ok = vm.editWorkout(entries, type, date, minutes.toIntOrNull()?.takeIf { it > 0 },
                    distance.trim().replace(',', '.').toDoubleOrNull()?.takeIf { it > 0 }, unit, start?.format(hhmm), end?.format(hhmm), comment)
                busy = false
                if (ok) done()
            }
        }) { Text("Save changes") }
    }
}

/** A step-challenge entry is a day and a count. */
@Composable
private fun EditStepsContent(vm: AppViewModel, a: MyActivity, done: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var date by remember { mutableStateOf(a.date) }
    var steps by remember { mutableStateOf(a.steps?.toString() ?: "") }
    var comment by remember { mutableStateOf(a.comment.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    Column(Modifier.verticalScroll(rememberScrollState()).padding(PagePadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionCard {
            OutlinedButton(onClick = {
                DatePickerDialog(context, { _, y, m, d -> date = LocalDate.of(y, m + 1, d) }, date.year, date.monthValue - 1, date.dayOfMonth).show()
            }, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.CalendarMonth, null); Spacer(Modifier.width(8.dp)); Text(fmtDay(date) + " " + date.year) }
            OutlinedTextField(steps, { steps = it.filter { ch -> ch.isDigit() }.take(6) }, label = { Text("Steps that day") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
            OutlinedTextField(comment, { comment = it.take(500) }, label = { Text("Comment (optional)") }, modifier = Modifier.fillMaxWidth())
            if (a.source == "health_connect") Text("This day came from your phone. The next sync sets it back to the phone's count if they differ.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Button(enabled = !busy && (steps.toIntOrNull() ?: 0) > 0, modifier = Modifier.fillMaxWidth(), onClick = {
            busy = true
            scope.launch {
                val ok = vm.call { it.editSteps(a.id, date, steps.toInt(), comment) } != null
                busy = false
                if (ok) { vm.message = "Steps updated"; vm.afterChange(); done() }
            }
        }) { Text("Save changes") }
    }
}

val ACTIVITY_TYPES_UI = com.activetogether.companion.ACTIVITY_TYPES
