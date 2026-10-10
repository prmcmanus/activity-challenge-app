package com.activetogether.companion.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.unit.dp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.Timeline
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument

private data class Tab(val route: String, val label: String, val icon: ImageVector)
private val TABS = listOf(
    Tab("challenges", "Challenges", Icons.Default.EmojiEvents),
    Tab("activity", "Activity", Icons.Default.Timeline),
    Tab("sync", "Sync", Icons.Default.Sync),
    Tab("profile", "Me", Icons.Default.Person),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppRoot(vm: AppViewModel) {
    if (!vm.signedIn) { LoginScreen(vm); return }

    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route ?: "challenges"
    val isTab = TABS.any { it.route == route }
    val snackbar = remember { SnackbarHostState() }
    // An invite link (opened now, or before signing in) goes to its confirm screen.
    LaunchedEffect(vm.pendingInvite) { vm.pendingInvite?.let { nav.navigate("invite/$it") { launchSingleTop = true } } }
    LaunchedEffect(vm.message) { vm.message?.let { snackbar.showSnackbar(it); vm.message = null } }
    // A tapped notification opens its challenge or ticket.
    LaunchedEffect(vm.pendingRoute) {
        val url = vm.pendingRoute ?: return@LaunchedEffect
        vm.pendingRoute = null
        Regex("^/challenges/(\\d+)").find(url)?.let { nav.navigate("challenge/${it.groupValues[1]}") { launchSingleTop = true } }
        Regex("^/help/tickets/(\\d+)").find(url)?.let { nav.navigate("ticket/${it.groupValues[1]}") { launchSingleTop = true } }
        Regex("^/users/(\\d+)").find(url)?.let { nav.navigate("user/${it.groupValues[1]}") { launchSingleTop = true } }
    }
    // Android 13 and later ask before an app shows notifications: once, when the server can send them.
    val notifyPermission = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(vm.pushAvailable) {
        if (vm.pushAvailable && android.os.Build.VERSION.SDK_INT >= 33 && !vm.prefs.askedPushPermission) {
            vm.prefs.askedPushPermission = true
            notifyPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    val title = when {
        route == "challenge/new" -> "New challenge"
        route == "challenge/{id}/edit" -> "Edit challenge"
        route == "join" -> "Join a challenge"
        route == "challenge/{id}/members" -> "Members"
        route.startsWith("team/") -> "Manage team"
        route.startsWith("challenge/") -> "Challenge"
        route.endsWith("/edit") -> "Edit activity"
        route.startsWith("activity/") -> "Activity"
        route.startsWith("user/") -> "Profile"
        route == "editProfile" -> "Edit profile"
        route == "help" -> "Help"
        route == "help/new" -> "New ticket"
        route.startsWith("ticket/") -> "Ticket"
        route == "support" -> "Support dashboard"
        route == "admin" -> "Admin"
        route.startsWith("invite/") -> "Invitation"
        route == "log" -> "Log activity"
        else -> "Active Together"
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text(title, fontWeight = FontWeight.Bold) },
                navigationIcon = { if (!isTab) IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    // A refresh button as well as pull-to-refresh on the lists, for anyone who doesn't think to pull.
                    if (route == "challenges" || route == "activity") IconButton(onClick = { vm.refreshTop() }, enabled = !vm.topRefreshing) { Icon(Icons.Default.Refresh, "Refresh") }
                    // Help is one tap from every main screen; the badge counts new replies (and, for admins, tickets waiting).
                    if (isTab) IconButton(onClick = { nav.navigate("help") }) {
                        BadgedBox(badge = { if (vm.helpBadge > 0) Badge { Text("${vm.helpBadge}") } }) { Icon(Icons.AutoMirrored.Filled.HelpOutline, "Help") }
                    }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        bottomBar = {
            if (isTab) NavigationBar {
                TABS.forEach { t ->
                    NavigationBarItem(
                        selected = route == t.route,
                        onClick = { nav.navigate(t.route) { popUpTo("challenges") { saveState = true }; launchSingleTop = true; restoreState = true } },
                        icon = { Icon(t.icon, null) },
                        label = { Text(t.label) },
                    )
                }
            }
        },
        floatingActionButton = {
            if (route == "activity") ExtendedFloatingActionButton(onClick = { nav.navigate("log") }, icon = { Icon(Icons.Default.Add, null) }, text = { Text("Log activity") })
        },
        snackbarHost = { SnackbarHost(snackbar) },
        containerColor = MaterialTheme.colorScheme.background,
    ) { pad ->
        androidx.compose.foundation.layout.Column(Modifier.padding(pad)) {
        // Without a connection the app shows what it last loaded, and says so.
        if (vm.offline || vm.pendingLogs > 0) androidx.compose.material3.Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
            Text(listOfNotNull(if (vm.offline) "Offline: showing what was last loaded." else null,
                if (vm.pendingLogs > 0) "${vm.pendingLogs} activit${if (vm.pendingLogs == 1) "y" else "ies"} waiting to be sent." else null).joinToString(" "),
                style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
        }
        NavHost(nav, startDestination = "challenges", modifier = Modifier.weight(1f)) {
            composable("challenges") {
                ChallengesScreen(vm, newChallenge = { nav.navigate("challenge/new") }, join = { nav.navigate("join") }) { c -> nav.navigate("challenge/${c.id}") }
            }
            composable("challenge/new") {
                ChallengeFormScreen(vm, null) { id -> nav.navigate(if (id != null) "challenge/$id" else "challenges") { popUpTo("challenges") } }
            }
            composable("join") { JoinScreen(vm) { id -> nav.navigate("challenge/$id") { popUpTo("challenges") } } }
            composable("challenge/{id}", arguments = listOf(navArgument("id") { type = NavType.IntType })) {
                val id = it.arguments!!.getInt("id")
                ChallengeDetailScreen(vm, id, edit = { nav.navigate("challenge/$id/edit") }, left = { nav.popBackStack("challenges", inclusive = false) },
                    members = { nav.navigate("challenge/$id/members") }, manageTeam = { tid -> nav.navigate("team/$id/$tid") }) { uid -> nav.navigate("user/$uid") }
            }
            composable("challenge/{id}/members", arguments = listOf(navArgument("id") { type = NavType.IntType })) {
                ChallengeMembersScreen(vm, it.arguments!!.getInt("id"))
            }
            composable("team/{cid}/{tid}", arguments = listOf(navArgument("cid") { type = NavType.IntType }, navArgument("tid") { type = NavType.IntType })) {
                TeamManageScreen(vm, it.arguments!!.getInt("cid"), it.arguments!!.getInt("tid")) { nav.popBackStack() }
            }
            composable("challenge/{id}/edit", arguments = listOf(navArgument("id") { type = NavType.IntType })) {
                // Saved: back to the challenge. Deleted: back to the admin list if that's where it was opened from, else the challenge list.
                ChallengeFormScreen(vm, it.arguments!!.getInt("id")) { id ->
                    if (id != null) nav.popBackStack() else if (!nav.popBackStack("admin", inclusive = false)) nav.popBackStack("challenges", inclusive = false)
                }
            }
            composable("activity") { ActivityListScreen(vm) { a -> nav.navigate("activity/${a.id}") } }
            composable("activity/{id}", arguments = listOf(navArgument("id") { type = NavType.IntType })) {
                val id = it.arguments!!.getInt("id")
                ActivityDetailScreen(vm, id, back = { nav.popBackStack() }, edit = { nav.navigate("activity/$id/edit") })
            }
            composable("activity/{id}/edit", arguments = listOf(navArgument("id") { type = NavType.IntType })) {
                EditActivityScreen(vm, it.arguments!!.getInt("id")) { nav.popBackStack() }
            }
            composable("user/{id}", arguments = listOf(navArgument("id") { type = NavType.IntType })) {
                UserProfileScreen(vm, it.arguments!!.getInt("id")) { uid -> nav.navigate("user/$uid") }
            }
            composable("log") { LogActivityScreen(vm) { nav.popBackStack() } }
            composable("sync") { SyncScreen(vm) }
            composable("profile") { MeScreen(vm, edit = { nav.navigate("editProfile") }, help = { nav.navigate("help") }, admin = { nav.navigate("admin") }) { uid -> nav.navigate("user/$uid") } }
            composable("invite/{code}") {
                InviteScreen(vm, it.arguments!!.getString("code")!!,
                    opened = { id -> nav.navigate("challenge/$id") { popUpTo("challenges") } },
                    dismiss = { if (!nav.popBackStack()) nav.navigate("challenges") })
            }
            composable("admin") { AdminScreen(vm) { id -> nav.navigate("challenge/$id") } }
            composable("help") {
                HelpScreen(vm, newTicket = { nav.navigate("help/new") }, openTicket = { id -> nav.navigate("ticket/$id") }, dashboard = { nav.navigate("support") })
            }
            composable("help/new") { NewTicketScreen(vm) { id -> nav.navigate("ticket/$id") { popUpTo("help") } } }
            composable("ticket/{id}", arguments = listOf(navArgument("id") { type = NavType.IntType })) { TicketScreen(vm, it.arguments!!.getInt("id")) }
            composable("support") { SupportDashboardScreen(vm) { id -> nav.navigate("ticket/$id") } }
            composable("editProfile") { EditProfileScreen(vm) { nav.popBackStack() } }
        }
        }
    }
}
