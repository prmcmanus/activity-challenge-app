package com.activetogether.companion.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.material.icons.filled.Person
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
    LaunchedEffect(vm.message) { vm.message?.let { snackbar.showSnackbar(it); vm.message = null } }

    val title = when {
        route.startsWith("challenge/") -> "Challenge"
        route.endsWith("/edit") -> "Edit activity"
        route.startsWith("activity/") -> "Activity"
        route.startsWith("user/") -> "Profile"
        route == "editProfile" -> "Edit profile"
        route == "help" -> "Help"
        route == "help/new" -> "New ticket"
        route.startsWith("ticket/") -> "Ticket"
        route == "support" -> "Support dashboard"
        route == "log" -> "Log activity"
        else -> "Active Together"
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text(title, fontWeight = FontWeight.Bold) },
                navigationIcon = { if (!isTab) IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
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
        NavHost(nav, startDestination = "challenges", modifier = Modifier.padding(pad)) {
            composable("challenges") { ChallengesScreen(vm) { c -> nav.navigate("challenge/${c.id}") } }
            composable("challenge/{id}", arguments = listOf(navArgument("id") { type = NavType.IntType })) {
                ChallengeDetailScreen(vm, it.arguments!!.getInt("id")) { uid -> nav.navigate("user/$uid") }
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
                UserProfileScreen(vm, it.arguments!!.getInt("id"))
            }
            composable("log") { LogActivityScreen(vm) { nav.popBackStack() } }
            composable("sync") { SyncScreen(vm) }
            composable("profile") { MeScreen(vm, edit = { nav.navigate("editProfile") }, help = { nav.navigate("help") }) }
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
