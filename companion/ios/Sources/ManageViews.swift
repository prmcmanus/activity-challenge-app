import SwiftUI

private let sourceLabel = ["manual": "logged by hand", "health_connect": "Health Connect", "health_kit": "Apple Health", "shortcut": "Apple Shortcut"]

/// An entry's amount in its challenge's measure: "5,200 steps", "3.1 mi" or "45 min".
private func entryAmount(_ d: ChallengeDetail?, _ e: MemberEntry) -> String {
    switch d?.measure ?? .minutes {
    case .steps: "\(fmtSteps(e.steps ?? 0)) steps"
    case .distance: "\(fmtNum(e.distance ?? 0)) \(d?.distanceUnit == "km" ? "km" : "mi")"
    case .minutes: "\(fmtNum(e.minutes ?? 0)) min"
    }
}

extension AppModel {
    /// A server call whose error shows next to the form instead of as a passing message.
    func tryInline<T>(_ onError: (String) -> Void, _ block: (API) async throws -> T) async -> T? {
        do { return try await block(api) }
        catch let e as APIError {
            if e.status == 401 { return await call { _ -> T in throw e } }
            onError(e.message); return nil
        } catch {
            onError("Couldn't reach Active Together: \(error.localizedDescription)"); return nil
        }
    }
    /// Keep (or open) a challenge someone added me to: the notice goes.
    func ackAdded(_ id: Int) async {
        guard await call({ try await $0.ackAdded(id) }) != nil else { return }
        if let i = challenges.firstIndex(where: { $0.id == id }) { challenges[i].addedBy = nil }
    }
}

/// A new invite code for a challenge or team: the old link and code stop working straight away. Global admins get a
/// suggested code they can keep or replace with their own (asked again if it's taken or not allowed).
struct NewInviteCodeSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let team: Bool, id: Int, what: String
    let done: (String) -> Void
    @State private var code = ""
    @State private var error: String?
    @State private var busy = false
    private var admin: Bool { model.me?.isAdmin == true }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("The current link and code for \(what) stop working straight away; people already in aren't affected.")
                }
                if admin {
                    Section {
                        TextField("Code", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled()
                            .onChange(of: code) { _, v in let f = String(v.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(20)); if f != v { code = f }; error = nil }
                    } footer: { Text("Keep this one or type your own: 6 to 20 letters and numbers.") }
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle(admin ? "New invite code" : "New invite link").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(admin ? "Use this code" : "Make new link") {
                        busy = true
                        Task {
                            if let c = await model.tryInline({ error = $0 }, { try await $0.newInviteCode(team: team, id: id, code: admin ? code : nil) }) { done(c); dismiss() }
                            busy = false
                        }
                    }.disabled(busy || (admin && code.count < 6))
                }
            }
            .task { if admin, code.isEmpty, let s = await model.tryInline({ error = $0 }, { try await $0.suggestInviteCode() }) { code = s } }
        }
        .presentationDetents([.medium, .large])
    }
}

/// Owners (and global admins): everyone in a challenge, adding people by email, their entries, and removing them.
struct ChallengeMembersView: View {
    @Environment(AppModel.self) private var model
    let challengeId: Int
    @State private var data: ChallengeMembers?
    @State private var note: String?
    @State private var error: String?
    @State private var email = ""
    @State private var teamId: Int?
    @State private var owner = false
    @State private var busy = false
    @State private var removing: Member?
    @State private var openEntries: Int?
    @State private var entries: [MemberEntry]?
    @State private var deleting: MemberEntry?

    var body: some View {
        Group {
            if let d = data { content(d) } else { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
        }
        .navigationTitle("Members").navigationBarTitleDisplayMode(.inline)
        .task { if model.details[challengeId] == nil { await model.loadDetail(challengeId) }; await reload() }
    }

    private func reload(_ msg: String? = nil) async {
        if let d = await model.tryInline({ error = $0 }, { try await $0.challengeMembers(challengeId) }) { data = d }
        if let msg { note = msg; error = nil }
    }
    private func loadEntries(_ uid: Int) async {
        entries = nil
        entries = await model.tryInline({ error = $0 }, { try await $0.memberEntries(challengeId: challengeId, userId: uid) }) ?? []
    }

    private func content(_ d: ChallengeMembers) -> some View {
        let detail = model.details[challengeId], individual = detail?.individual ?? d.teams.isEmpty
        let meId = model.me?.id, admin = model.me?.isAdmin == true
        return Page(refresh: { await reload() }) {
            SectionCard("Add someone") {
                TextField("Their email", text: $email).textFieldStyle(.roundedBorder).keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                if !individual {
                    Picker("Team", selection: $teamId) {
                        Text("No team yet").tag(Int?.none)
                        ForEach(d.teams, id: \.id) { Text($0.name).tag(Int?.some($0.id)) }
                    }
                }
                Picker("Role", selection: $owner) { Text("Member").tag(false); Text("Owner").tag(true) }.pickerStyle(.segmented)
                Button {
                    busy = true
                    Task {
                        if let r = await model.tryInline({ error = $0; note = nil }, { try await $0.addMember(challengeId: challengeId, email: email, owner: owner, teamId: teamId) }) {
                            let (added, name) = r
                            email = ""; await model.refreshChallenge(challengeId)
                            await reload(added ? "Added \(name). They've been told." : "\(name) was already in; their team and role are updated.")
                        }
                        busy = false
                    }
                } label: { Label("Add to challenge", systemImage: "person.badge.plus") }
                    .buttonStyle(.borderedProminent).disabled(busy || !email.contains("@"))
                EmptyNote("Anyone with an account. They're told, and can leave if they didn't expect it. No account yet? Share the invite link.")
                if let error { Text(error).foregroundStyle(.red) }
                if let note { Text(note).foregroundStyle(Color.brandRed) }
            }
            Text("\(d.members.count) \(d.members.count == 1 ? "member" : "members")" + (individual ? " · individuals" : " · \(d.teams.count) \(d.teams.count == 1 ? "team" : "teams")"))
                .font(.headline)
            ForEach(d.members) { m in
                SectionCard {
                    HStack {
                        Avatar(url: m.avatarURL, name: m.name)
                        VStack(alignment: .leading) {
                            Text(m.name + (m.id == meId ? " (you)" : "")).font(.headline)
                            Text([m.email, m.role == "owner" ? "owner" : "member", m.teams ?? (individual ? nil : "no team"),
                                  "\(m.entries) \(m.entries == 1 ? "entry" : "entries")", m.deactivated ? "deactivated" : nil].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    HStack {
                        if m.entries > 0 {
                            Button(openEntries == m.id ? "Hide entries" : "Entries") {
                                if openEntries == m.id { openEntries = nil } else { openEntries = m.id; Task { await loadEntries(m.id) } }
                            }.buttonStyle(.bordered)
                        }
                        if m.id != meId || admin { Button("Remove", role: .destructive) { removing = m } }
                    }
                    if openEntries == m.id {
                        if let list = entries {
                            if list.isEmpty { EmptyNote("No entries.") }
                            ForEach(list) { e in
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text("\(e.type) · \(entryAmount(detail, e))")
                                        Text([fmtDay(e.date), e.startTime, e.teamName, sourceLabel[e.source] ?? e.source, e.comment.map { "“\($0)”" }].compactMap { $0 }.joined(separator: " · "))
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Button(role: .destructive) { deleting = e } label: { Image(systemName: "trash") }.accessibilityLabel("Delete entry")
                                }
                                Divider()
                            }
                        } else { ProgressView().frame(maxWidth: .infinity) }
                    }
                }
            }
        }
        .alert("Remove \(removing?.name ?? "them")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { m in
            Button("Remove", role: .destructive) {
                Task {
                    if await model.tryInline({ error = $0 }, { try await $0.removeMember(challengeId: challengeId, userId: m.id) }) != nil {
                        await model.refreshChallenge(challengeId); await reload("Removed \(m.name).")
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in Text("They're taken out of the challenge and its teams, and everything they logged in it is deleted. They'd need the invite link to come back.") }
        .alert("Delete this entry?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { e in
            Button("Delete entry", role: .destructive) {
                Task {
                    if await model.tryInline({ error = $0 }, { try await $0.deleteActivity(e.id) }) != nil {
                        await model.refreshChallenge(challengeId); await reload("Entry deleted.")
                        if let uid = openEntries { await loadEntries(uid) }
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in Text("It stops counting straight away, and the person can't undo it.") }
    }
}

/// A team admin, the challenge's owners or a global admin: rename the team, its people, its invite code, or delete it.
struct TeamManageView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    let challengeId: Int, teamId: Int
    @State private var members: [TeamMember]?
    @State private var name = ""
    @State private var email = ""
    @State private var note: String?
    @State private var error: String?
    @State private var busy = false
    @State private var removing: TeamMember?
    @State private var newCode = false
    @State private var deleting = false

    private var team: TeamInfo? { model.details[challengeId]?.teams.first { $0.id == teamId } }

    var body: some View {
        Group {
            if let list = members { content(list) } else { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
        }
        .navigationTitle("Manage team").navigationBarTitleDisplayMode(.inline)
        .task {
            if model.details[challengeId] == nil { await model.loadDetail(challengeId) }
            name = team?.name ?? ""
            await reload()
        }
    }

    private func reload(_ msg: String? = nil) async {
        if let m = await model.tryInline({ error = $0 }, { try await $0.teamMembers(teamId) }) { members = m }
        if let msg { note = msg; error = nil }
    }

    private func content(_ list: [TeamMember]) -> some View {
        let owner = model.details[challengeId]?.canManage == true
        return Page(refresh: { await model.refreshChallenge(challengeId); await reload() }) {
            SectionCard("Team name") {
                TextField("Name", text: $name).textFieldStyle(.roundedBorder)
                Button("Save name") {
                    busy = true
                    Task {
                        if await model.tryInline({ error = $0; note = nil }, { try await $0.renameTeam(teamId, name: name) }) != nil {
                            await model.refreshChallenge(challengeId); note = "Saved."; error = nil
                        }
                        busy = false
                    }
                }.buttonStyle(.borderedProminent)
                    .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty || name.trimmingCharacters(in: .whitespaces) == team?.name)
                EmptyNote("The team's logo can be changed on the website.")
            }
            SectionCard(title: "Invite code", action: { Button("New code") { newCode = true } }, content: {
                Text(team?.inviteCode ?? "").font(.title2.bold()).textSelection(.enabled)
                EmptyNote("Anyone with the team's link or code joins the challenge and this team.")
            })
            SectionCard("Members") {
                if list.isEmpty { EmptyNote("No members.") }
                ForEach(list) { m in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(m.name).font(.headline)
                            Text([m.email, m.role == "team_admin" ? "team admin" : "member"].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Remove", role: .destructive) { removing = m }
                    }
                    Divider()
                }
                TextField(owner ? "Add someone by email" : "Add someone already in this challenge (their email)", text: $email).textFieldStyle(.roundedBorder)
                    .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Add to team") {
                    busy = true
                    Task {
                        if let who = await model.tryInline({ error = $0; note = nil }, { try await $0.addTeamMember(teamId, email: email) }) {
                            email = ""; await model.refreshChallenge(challengeId); await reload("Added \(who).")
                        }
                        busy = false
                    }
                }.buttonStyle(.borderedProminent).disabled(busy || !email.contains("@"))
                EmptyNote(owner ? "Anyone with an account: they're added to the challenge too, and told." : "To bring someone new in, share the team's invite code.")
                if let error { Text(error).foregroundStyle(.red) }
                if let note { Text(note).foregroundStyle(Color.brandRed) }
            }
            Button(role: .destructive) { deleting = true } label: { Label("Delete this team", systemImage: "trash").frame(maxWidth: .infinity) }
                .buttonStyle(.bordered).controlSize(.large)
        }
        .sheet(isPresented: $newCode) {
            NewInviteCodeSheet(team: true, id: teamId, what: "the team \"\(team?.name ?? name)\"") { code in
                Task { await model.refreshChallenge(challengeId); note = "New code: \(code)"; error = nil }
            }
        }
        .alert("Remove \(removing?.name ?? "them") from the team?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { m in
            Button("Remove", role: .destructive) {
                Task {
                    if await model.tryInline({ error = $0 }, { try await $0.removeTeamMember(teamId, userId: m.id) }) != nil {
                        await model.refreshChallenge(challengeId); await reload("Removed \(m.name).")
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in Text("What they logged under it stays on the team total. They stay in the challenge.") }
        .alert("Delete \(team?.name ?? "this team")?", isPresented: $deleting) {
            Button("Delete team", role: .destructive) {
                Task {
                    if await model.tryInline({ error = $0 }, { try await $0.deleteTeam(teamId) }) != nil {
                        await model.refreshChallenge(challengeId); model.message = "Team deleted"; router.pop()
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("This removes its members and any activity logged under it. This cannot be undone.") }
    }
}
