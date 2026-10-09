package com.activetogether.companion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.AutofillType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.activetogether.companion.ActiveTogetherApi
import com.activetogether.companion.PolicyActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Creating an account in the app: name, email and password, and on an invite-only site the invite code (filled
 * in already when an invite link brought them here). Signed in straight afterwards.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun CreateAccountCard(vm: AppViewModel, backToSignIn: () -> Unit) {
    val context = LocalContext.current
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var invite by remember { mutableStateOf(vm.pendingInvite.orEmpty()) }
    var inviteOnly by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { inviteOnly = runCatching { withContext(Dispatchers.IO) { ActiveTogetherApi().inviteOnly() } }.getOrDefault(false) }
    Card(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.large, elevation = CardDefaults.cardElevation(6.dp)) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Create your account", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true,
                modifier = Modifier.fillMaxWidth().autofill(listOf(AutofillType.PersonFullName)) { name = it },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Next))
            OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true,
                modifier = Modifier.fillMaxWidth().autofill(listOf(AutofillType.EmailAddress)) { email = it },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next))
            OutlinedTextField(password, { password = it }, label = { Text("Password (at least 8 characters)") }, singleLine = true,
                modifier = Modifier.fillMaxWidth().autofill(listOf(AutofillType.NewPassword)) { password = it },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = if (inviteOnly && vm.pendingInvite == null) ImeAction.Next else ImeAction.Done))
            if (inviteOnly && vm.pendingInvite == null) {
                OutlinedTextField(invite, { invite = it.uppercase() }, label = { Text("Invite code") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done))
                Text("Active Together is invite only: use the code from the invite someone sent you.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            Button(
                onClick = {
                    busy = true; error = null
                    vm.register(name, email, password, invite.trim().ifBlank { null }) { e -> busy = false; error = e }
                },
                enabled = !busy && name.isNotBlank() && email.isNotBlank() && password.length >= 8,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                else Text("Create account", fontWeight = FontWeight.Bold)
            }
            Text("By creating an account you agree to our privacy policy.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = { PolicyActivity.open(context) }) { Text("Privacy policy") }
            TextButton(onClick = backToSignIn) { Text("I have an account: sign in") }
        }
    }
}
