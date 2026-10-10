package com.activetogether.companion.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.autofill.AutofillNode
import androidx.compose.ui.autofill.AutofillType
import androidx.compose.ui.composed
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalAutofill
import androidx.compose.ui.platform.LocalAutofillTree
import kotlinx.coroutines.launch
import com.activetogether.companion.R
import com.activetogether.companion.SERVER_URL

/** Tells Android's autofill (password managers) what a text field is for, and fills it when one is picked. */
@OptIn(ExperimentalComposeUiApi::class)
internal fun Modifier.autofill(types: List<AutofillType>, onFill: (String) -> Unit): Modifier = composed {
    val node = remember { AutofillNode(autofillTypes = types, onFill = onFill) }
    val autofill = LocalAutofill.current
    LocalAutofillTree.current += node
    onGloballyPositioned { node.boundingBox = it.boundsInWindow() }
        .onFocusChanged { if (it.isFocused) autofill?.requestAutofillForNode(node) else autofill?.cancelAutofillForNode(node) }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun LoginScreen(vm: AppViewModel) {
    var email by remember { mutableStateOf(vm.prefs.email) }
    var password by remember { mutableStateOf("") }
    var ticket by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(vm.message) }
    // Creating an account, rather than signing in (from the button below, or an invite card).
    var creating by remember { mutableStateOf(false) }
    // Sign in with Google: shown once the server says it's set up; a credential waits here while we ask for an invite code.
    val activity = androidx.compose.ui.platform.LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var googleClient by remember { mutableStateOf<String?>(null) }
    var waitingCredential by remember { mutableStateOf<String?>(null) }
    var socialInvite by remember { mutableStateOf("") }
    androidx.compose.runtime.LaunchedEffect(Unit) { googleClient = runCatching { kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { com.activetogether.companion.ActiveTogetherApi().googleClientId() } }.getOrNull() }
    fun googleWith(credential: String, invite: String?) = vm.socialSignIn("google", credential, invite) { e, next, inviteNeeded ->
        busy = false; error = e
        if (inviteNeeded) waitingCredential = credential else { waitingCredential = null; if (next != null) ticket = next }
    }
    val signInWithGoogle: (() -> Unit)? = googleClient?.let { id -> {
        busy = true; error = null
        scope.launch {
            val token = runCatching { googleIdToken(activity, id) }
            token.onSuccess { googleWith(it, vm.pendingInvite) }.onFailure { e ->
                busy = false
                if (e !is androidx.credentials.exceptions.GetCredentialCancellationException) error = e.message ?: "Signing in with Google didn't work"
            }
        }
    } }
    var code by remember { mutableStateOf("") }

    Box(
        Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(BrandRedDeep, BrandRed, MaterialTheme.colorScheme.background), endY = 1600f))
    ) {
        Column(
            Modifier.fillMaxSize().systemBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // The logo as a plain picture: the launcher icon is an adaptive icon, which Image() can't draw.
            Image(painterResource(R.drawable.app_logo), contentDescription = null, modifier = Modifier.padding(top = 32.dp).size(96.dp).clip(MaterialTheme.shapes.large))
            Text("Active Together", style = MaterialTheme.typography.headlineMedium, color = Color.White)
            Text(if (creating) "Create your Active Together account to join challenges, log activity and sync your workouts."
                else "Sign in with your Active Together account to see your challenges, log activity and sync your workouts.",
                color = Color.White.copy(alpha = 0.9f), textAlign = TextAlign.Center)
            vm.pendingInvite?.let { InviteSignInCard(it, creating) { creating = true } }
            if (waitingCredential != null) {
                // Signing up with Google on an invite-only site: the invite code, then the same Google sign-in again.
                Card(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.large, elevation = CardDefaults.cardElevation(6.dp)) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("Your invite code", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                        error?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                        OutlinedTextField(socialInvite, { socialInvite = it.uppercase() }, label = { Text("Invite code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        Button(onClick = { busy = true; googleWith(waitingCredential!!, socialInvite.trim()) }, enabled = !busy && socialInvite.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("Create my account", fontWeight = FontWeight.Bold) }
                        androidx.compose.material3.TextButton(onClick = { waitingCredential = null; error = null }) { Text("Back") }
                    }
                }
                return@Column
            }
            if (creating) { CreateAccountCard(vm, signInWithGoogle) { creating = false }; return@Column }
            Card(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.large, elevation = CardDefaults.cardElevation(6.dp)) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (ticket == null) {
                        signInWithGoogle?.let { GoogleButton(enabled = !busy, onClick = it) }
                        // Autofill hints, so a password manager (or Google's) fills these in.
                        OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true,
                            modifier = Modifier.fillMaxWidth().autofill(listOf(AutofillType.EmailAddress, AutofillType.Username)) { email = it },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next))
                        OutlinedTextField(password, { password = it }, label = { Text("Password") }, singleLine = true,
                            modifier = Modifier.fillMaxWidth().autofill(listOf(AutofillType.Password)) { password = it },
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done))
                    } else {
                        // Two-step sign-in: the code from the authenticator app, or a backup code.
                        Text("Enter the 6-digit code from your authenticator app, or one of your backup codes.", style = MaterialTheme.typography.bodyMedium)
                        OutlinedTextField(code, { code = it }, label = { Text("Code") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done))
                        androidx.compose.material3.TextButton(onClick = { ticket = null; code = ""; error = null }) { Text("Start again") }
                    }
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                    Button(
                        onClick = {
                            busy = true; error = null
                            val t = ticket
                            if (t == null) vm.signIn(email, password) { e, next -> busy = false; error = e; if (next != null) ticket = next; if (e == null) password = "" }
                            else vm.signInCode(t, code) { e -> busy = false; error = e; if (e == null) { code = ""; ticket = null } }
                        },
                        enabled = !busy && (if (ticket == null) email.isNotBlank() && password.isNotEmpty() else code.isNotBlank()),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                        else Text("Sign in", fontWeight = FontWeight.Bold)
                    }
                    val forgotContext = androidx.compose.ui.platform.LocalContext.current
                    androidx.compose.material3.TextButton(onClick = { openInBrowser(forgotContext, "$SERVER_URL/forgot") }) { Text("Forgot password?") }
                    androidx.compose.material3.TextButton(onClick = { creating = true; error = null }) { Text("New here? Create an account") }
                    androidx.compose.material3.TextButton(onClick = { com.activetogether.companion.PolicyActivity.open(forgotContext) }) { Text("Privacy policy") }
                }
            }
        }
    }
}
