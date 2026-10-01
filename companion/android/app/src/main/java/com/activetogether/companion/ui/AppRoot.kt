package com.activetogether.companion.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
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
        route.startsWith("activity/") -> "Activity"
        route == "log" -> "Log activity"
        else -> "Active Together"
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text(title, fontWeight = FontWeight.Bold) },
                navigationIcon = { if (!isTab) IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
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
                ChallengeDetailScreen(vm, it.arguments!!.getInt("id"))
            }
            composable("activity") { ActivityListScreen(vm) { a -> nav.navigate("activity/${a.id}") } }
            composable("activity/{id}", arguments = listOf(navArgument("id") { type = NavType.IntType })) {
                ActivityDetailScreen(vm, it.arguments!!.getInt("id")) { nav.popBackStack() }
            }
            composable("log") { LogActivityScreen(vm) { nav.popBackStack() } }
            composable("sync") { SyncScreen(vm) }
            composable("profile") { ProfileScreen(vm) }
        }
    }
}
