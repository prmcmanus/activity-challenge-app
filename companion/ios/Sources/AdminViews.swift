import SwiftUI

private let adminStates = [("", "All"), ("running", "Running"), ("upcoming", "Not started"), ("finished", "Finished")]
private func plural(_ n: Int, _ one: String, _ many: String) -> String { "\(n) \(n == 1 ? one : many)" }

/// Global admins: every user and every challenge on the site, whether or not they're in it.
struct AdminView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @State private var tab = 0
    @State private var query = ""
    @State private var stateFilter = ""
    @State private var users: [AdminUser]?
    @State private var challenges: [AdminChallenge]?
    @State private var editing: AdminUser?
    @State private var creating = false

    var body: some View {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        Page(refresh: load) {
            Hero("Administration", "Users and challenges") { Text("Everything on the site, whether or not you've joined it.").foregroundStyle(.white.opacity(0.9)) }
            Picker("", selection: $tab) {
                Text("Users" + (users.map { " (\($0.count))" } ?? "")).tag(0)
                Text("Challenges" + (challenges.map { " (\($0.count))" } ?? "")).tag(1)
            }.pickerStyle(.segmented)
            TextField(tab == 0 ? "Search name or email" : "Search name, owner or code", text: $query).textFieldStyle(.roundedBorder)
            if tab == 0 {
                Button { creating = true } label: { Label("New user", systemImage: "person.badge.plus").frame(maxWidth: .infinity) }.buttonStyle(.bordered)
                if let list = users {
                    let rows = list.filter { q.isEmpty || "\($0.name) \($0.email)".lowercased().contains(q) }
                    if rows.isEmpty { SectionCard { EmptyNote("No users match.") } }
                    ForEach(rows) { u in Button { editing = u } label: { userCard(u) }.buttonStyle(.plain) }
                } else { ProgressView().frame(maxWidth: .infinity) }
            } else {
                Picker("Show", selection: $stateFilter) { ForEach(adminStates, id: \.0) { Text($0.1).tag($0.0) } }.pickerStyle(.segmented)
                if let list = challenges {
                    let rows = list.filter { (stateFilter.isEmpty || $0.state == stateFilter) && (q.isEmpty || "\($0.name) \($0.owners ?? "") \($0.inviteCode)".lowercased().contains(q)) }
                    if rows.isEmpty { SectionCard { EmptyNote("No challenges match.") } }
                    ForEach(rows) { c in Button { router.push(.challenge(c.id)) } label: { challengeCard(c) }.buttonStyle(.plain) }
                } else { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .navigationTitle("Admin").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(item: $editing) { u in UserSheet(existing: u, isMe: u.id == model.me?.id) { await load() } }
        .sheet(isPresented: $creating) { UserSheet(existing: nil, isMe: false) { await load() } }
    }

    private func load() async {
        if let u = await model.call({ try await $0.adminUsers() }) { users = u }
        if let c = await model.call({ try await $0.adminChallenges() }) { challenges = c }
    }

    private func userCard(_ u: AdminUser) -> some View {
        SectionCard {
            HStack {
                Avatar(url: u.avatarURL, name: u.name)
                VStack(alignment: .leading) {
                    Button(u.name + (u.id == model.me?.id ? " (you)" : "")) { model.openProfile(u.id) }.font(.headline).buttonStyle(.plain).foregroundStyle(Color.brandRed)
                    Text(u.email).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing) {
                    Pill(text: u.isAdmin ? "Global admin" : "Member", background: u.isAdmin ? Color.brandRed.opacity(0.15) : Color(.tertiarySystemFill), foreground: .primary)
                    if u.deactivatedAt != nil { Text("Deactivated").font(.caption.bold()).foregroundStyle(.red) }
                }
            }
            Text([plural(u.challenges, "challenge", "challenges"), plural(u.activities, "activity", "activities"), u.lastActivity.map { "last active \($0)" } ?? "no activity yet",
                  u.tickets > 0 ? plural(u.tickets, "ticket", "tickets") : nil, "joined \(u.createdAt)"].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func challengeCard(_ c: AdminChallenge) -> some View {
        SectionCard {
            HStack {
                VStack(alignment: .leading) {
                    Text(c.name).font(.headline).foregroundStyle(.primary)
                    Text(fmtRange(c.startDate, c.endDate)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Pill(text: adminStates.first { $0.0 == c.state }?.1 ?? c.state, background: c.state == "running" ? Color.green.opacity(0.18) : Color(.tertiarySystemFill), foreground: .primary)
                Image(systemName: "chevron.right").foregroundStyle(.secondary)
            }
            Text([c.measure == .steps ? "Steps" : c.measure == .distance ? "Distance (\(unitLong(c.distanceUnit)))" : "Active minutes",
                  c.individual ? "Individuals" : plural(c.teams, "team", "teams"), plural(c.members, "member", "members"), plural(c.activities, "activity", "activities"),
                  "owner: \(c.owners ?? "none")", "code \(c.inviteCode)", c.state == "finished" ? "deleted on \(c.purgeDate)" : nil].compactMap { $0 }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// Create (existing nil) or edit an account, with deactivate/reactivate and delete for others.
private struct UserSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let existing: AdminUser?
    let isMe: Bool
    let changed: () async -> Void
    @State private var name = ""
    @State private var email = ""
    @State private var role = "member"
    @State private var password = ""
    @State private var busy = false
    @State private var confirmDelete = false
    @State private var typedEmail = ""
    @State private var loaded = false

    private var passwordOK: Bool { existing == nil ? password.count >= 8 : (password.isEmpty || password.count >= 8) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                    TextField("Email", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("Role", selection: $role) { Text("Member").tag("member"); Text("Global admin").tag("global_admin") }
                }
                Section(footer: Text(existing == nil ? "At least 8 characters. Share it with them to sign in." : "Leave blank to keep theirs. Setting one signs them out everywhere.")) {
                    SecureField(existing == nil ? "Temporary password" : "Reset password (optional)", text: $password)
                }
                if let u = existing, !isMe {
                    Section(footer: Text(u.deactivatedAt != nil ? "Deactivated \(u.deactivatedAt!). They can't sign in; their activity still counts." : "Deactivating signs them out and stops them signing in. Their activity stays on the leaderboards.")) {
                        Button(u.deactivatedAt != nil ? "Reactivate" : "Deactivate") {
                            busy = true
                            Task {
                                if await model.call({ try await $0.adminSetActive(u.id, active: u.deactivatedAt != nil) }) != nil {
                                    model.message = u.deactivatedAt != nil ? "\(u.name) reactivated" : "\(u.name) deactivated"; await changed(); dismiss()
                                }
                                busy = false
                            }
                        }.disabled(busy)
                        Button("Delete", role: .destructive) { typedEmail = ""; confirmDelete = true }.disabled(busy)
                    }
                }
            }
            .navigationTitle(existing.map { "Edit \($0.name)" } ?? "New user").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(existing == nil ? "Create" : "Save") { save() }.disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty || !email.contains("@") || !passwordOK)
                }
            }
            .onAppear { if !loaded, let u = existing { loaded = true; name = u.name; email = u.email; role = u.role } }
            .alert("Delete \(existing?.name ?? "")?", isPresented: $confirmDelete) {
                TextField("Their email", text: $typedEmail).textInputAutocapitalization(.never)
                Button("Delete for good", role: .destructive) {
                    guard let u = existing, typedEmail.trimmingCharacters(in: .whitespaces).lowercased() == u.email.lowercased() else { model.message = "The email didn't match, so nothing was deleted."; return }
                    Task { if await model.call({ try await $0.adminDeleteUser(u.id) }) != nil { model.message = "\(u.name) deleted"; await changed(); dismiss() } }
                }
                Button("Cancel", role: .cancel) {}
            } message: { Text("This permanently removes the account with all their activity, routes, team memberships and tickets. Challenges and teams they created stay, credited to you. Type their email to confirm.") }
        }
    }

    private func save() {
        busy = true
        let n = name.trimmingCharacters(in: .whitespaces), e = email.trimmingCharacters(in: .whitespaces)
        Task {
            let ok: Bool
            if let u = existing { ok = await model.call({ try await $0.adminUpdateUser(u.id, name: n, email: e, role: role, password: password) }) != nil }
            else { ok = await model.call({ try await $0.adminCreateUser(name: n, email: e, role: role, password: password) }) != nil }
            busy = false
            if ok {
                model.message = existing == nil ? "User created" : "Saved"
                if existing?.id == model.me?.id, let m = await model.call({ try await $0.me() }) { model.me = m }
                await changed(); dismiss()
            }
        }
    }
}
