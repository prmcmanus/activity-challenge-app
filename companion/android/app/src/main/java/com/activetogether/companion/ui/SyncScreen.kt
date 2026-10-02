package com.activetogether.companion.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Route
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.contracts.ExerciseRouteRequestContract
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import com.activetogether.companion.RouteState
import com.activetogether.companion.toPoints
import kotlinx.coroutines.launch

/** Health Connect's own screen for this app's permissions - the way back once the dialog stops appearing. */
fun openHealthConnectSettings(context: android.content.Context) {
    val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
        Intent("android.health.connect.action.MANAGE_HEALTH_PERMISSIONS").putExtra(Intent.EXTRA_PACKAGE_NAME, context.packageName)
    else Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
    try { context.startActivity(intent) } catch (e: ActivityNotFoundException) {
        runCatching { context.startActivity(Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)) }
    }
}

@Composable
private fun AccessRow(label: String, granted: Boolean, note: String? = null) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(if (granted) Icons.Default.CheckCircle else Icons.Default.RadioButtonUnchecked, null,
            tint = if (granted) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.titleMedium)
            note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class, androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun SyncScreen(vm: AppViewModel) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val health = vm.health
    var granted by remember { mutableStateOf<Set<String>>(emptySet()) }
    var sdk by remember { mutableStateOf(health.status()) }
    fun refreshAccess() = scope.launch {
        sdk = health.status()
        granted = if (sdk == HealthConnectClient.SDK_AVAILABLE) runCatching { health.grantedPermissions() }.getOrDefault(emptySet()) else emptySet()
    }
    // Back from Health Connect's settings: re-read what is allowed.
    LifecycleResumeEffect(Unit) { refreshAccess(); onPauseOrDispose { } }

    val permissionLauncher = rememberLauncherForActivityResult(PermissionController.createRequestPermissionResultContract()) { refreshAccess() }
    var routeFor by remember { mutableStateOf<ReviewItem?>(null) }
    val routeLauncher = rememberLauncherForActivityResult(ExerciseRouteRequestContract()) { route ->
        routeFor?.let { vm.setConsentedRoute(it, route?.toPoints()) }
        routeFor = null
    }

    val hasWorkouts = granted.containsAll(health.requiredPermissions)
    val hasDistance = health.distancePermission in granted
    val historySupported = remember(sdk) { runCatching { health.historyReadSupported() }.getOrDefault(false) }
    val review = vm.review

    var refreshing by remember { mutableStateOf(false) }
    PullToRefreshBox(modifier = Modifier.fillMaxSize(), isRefreshing = refreshing, onRefresh = {
        scope.launch { refreshing = true; refreshAccess().join(); if (review != null) vm.startReview().join(); refreshing = false }
    }) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Hero("Health Connect", "Sync workouts", below = {
                Text("Workouts from Health Connect go into every challenge they fit.",
                    color = Color.White.copy(alpha = 0.9f), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 6.dp))
            })
        }
        when (sdk) {
            HealthConnectClient.SDK_UNAVAILABLE -> item { SectionCard { EmptyNote("Health Connect isn't available on this phone.") } }
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> item {
                SectionCard("Health Connect needed") {
                    EmptyNote("Install or update Health Connect from the Play Store, then come back.")
                    Button(onClick = {
                        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.google.android.apps.healthdata")).setPackage("com.android.vending")) }
                    }) { Text("Open Play Store") }
                }
            }
            else -> item {
                val allAllowed = hasWorkouts && hasDistance && (!historySupported || health.historyPermission in granted)
                if (allAllowed) {
                    SectionCard {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.CheckCircle, null, tint = MaterialTheme.colorScheme.tertiary); Spacer(Modifier.width(10.dp))
                            Text("Health Connect access allowed", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                            TextButton(onClick = { openHealthConnectSettings(context) }) { Text("Settings") }
                        }
                    }
                } else SectionCard("Access") {
                    AccessRow("Workouts", hasWorkouts, "Needed to sync anything")
                    AccessRow("Distance", hasDistance, "For distance challenges")
                    if (historySupported) AccessRow("Older than 30 days", health.historyPermission in granted, "For challenges that started more than 30 days ago")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (!hasWorkouts || !hasDistance || (historySupported && health.historyPermission !in granted)) {
                            Button(onClick = {
                                vm.prefs.askedDistance = true
                                permissionLauncher.launch(health.permissions + (if (historySupported) setOf(health.historyPermission) else emptySet()))
                            }) { Text("Allow access") }
                        }
                        TextButton(onClick = { openHealthConnectSettings(context) }) { Text("Health Connect settings") }
                    }
                }
            }
        }

        if (review == null) {
            item {
                Button(onClick = { vm.startReview() }, enabled = hasWorkouts && !vm.syncBusy, modifier = Modifier.fillMaxWidth()) {
                    if (vm.syncBusy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    else { Icon(Icons.Default.Sync, null); Spacer(Modifier.width(8.dp)); Text("Review workouts to sync") }
                }
            }
            val status = vm.syncStatus.ifBlank { vm.prefs.lastSyncSummary.takeIf { it.isNotBlank() }?.let { "Last sync: $it" }.orEmpty() }
            if (status.isNotBlank()) item { Text(status, style = MaterialTheme.typography.bodyMedium) }
        } else {
            item {
                Text("Tick the workouts to sync, check the type and distance, and choose the challenges each one counts in.",
                    style = MaterialTheme.typography.bodyMedium)
            }
            items(review, key = { it.candidate.workout.sourceRef }) { item -> ReviewCard(vm, item, onAddRoute = { routeFor = item; routeLauncher.launch(item.candidate.workout.sessionId) }) }
            item {
                val count = review.count { it.include && it.into.isNotEmpty() }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { vm.cancelReview() }, modifier = Modifier.weight(1f)) { Text("Cancel") }
                    Button(onClick = { vm.uploadReview() }, enabled = count > 0 && !vm.syncBusy, modifier = Modifier.weight(1f)) {
                        if (vm.syncBusy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                        else Text("Sync $count workout${if (count == 1) "" else "s"}")
                    }
                }
            }
        }
    }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ReviewCard(vm: AppViewModel, item: ReviewItem, onAddRoute: () -> Unit) {
    val w = item.candidate.workout
    val done = item.candidate.outstanding.isEmpty()
    SectionCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(item.include, { item.include = it }, enabled = !done)
            Column(Modifier.weight(1f)) {
                Text("${fmtDay(w.day)} · ${w.startTime}–${w.endTime}", style = MaterialTheme.typography.titleMedium)
                Text("${w.minutes} min" + if (done) " · already synced everywhere it fits" else "",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (!done) {
            val types = if (item.type in ACTIVITY_TYPES_UI) ACTIVITY_TYPES_UI else listOf(item.type) + ACTIVITY_TYPES_UI
            Dropdown("Activity type", types, item.type, { it }, { item.type = it })
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(item.distanceText, { item.distanceEdited(it) }, label = { Text("Distance") }, singleLine = true,
                    modifier = Modifier.weight(1f), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    supportingText = if (w.distanceMeters == null) ({ Text("Not recorded - type it if you know it") }) else null)
                Dropdown("Unit", listOf("mi", "km"), item.unit, { if (it == "km") "km" else "miles" }, { item.switchUnit(it) }, Modifier.width(130.dp))
            }
            Text("Counts in", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                item.candidate.fits.forEach { c ->
                    val already = c.id in item.candidate.alreadyIn
                    val needsDistance = c.measuresDistance && item.distanceMeters() == null
                    FilterChip(
                        selected = already || c.id in item.into,
                        enabled = !already,
                        onClick = { if (c.id in item.into) item.into.remove(c.id) else item.into.add(c.id) },
                        label = { Text(c.name + when { already -> " · synced"; needsDistance && c.id in item.into -> " · needs distance"; else -> "" }) },
                    )
                }
            }
            if (vm.prefs.includeRoutes) {
                when (val r = item.route) {
                    is RouteState.Available -> Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Route, null, tint = MaterialTheme.colorScheme.tertiary); Spacer(Modifier.width(6.dp))
                        Text("Route included (${r.points.size} points)", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    }
                    RouteState.NeedsConsent -> OutlinedButton(onClick = onAddRoute) {
                        Icon(Icons.Default.Route, null); Spacer(Modifier.width(6.dp)); Text("Add route from ${w.sourceApp.substringAfterLast('.')}")
                    }
                    RouteState.None -> {}
                }
            }
        }
    }
}
