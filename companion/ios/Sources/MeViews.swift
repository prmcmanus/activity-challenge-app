import SwiftUI
import UIKit
import PhotosUI

let sharingLevels: [(code: String, label: String, detail: String)] = [
    ("private", "Private", "Name and photo only"),
    ("summary", "Totals", "Plus my total and rank in each challenge we share"),
    ("full", "Full", "Plus my recent activity in challenges we share"),
]
func sharingLabel(_ code: String) -> String { sharingLevels.first { $0.code == code }?.label ?? "Totals" }

/// Follower and following counts, the follow button (someone else's profile only), and both lists.
private struct FollowCard: View {
    @Environment(Router.self) private var router
    let p: Profile
    let follow: (() async -> Void)?
    @State private var tab = 0
    var body: some View {
        SectionCard {
            HStack {
                VStack(alignment: .leading) {
                    Text("\(p.followersCount) follower\(p.followersCount == 1 ? "" : "s") · \(p.followingCount) following").font(.headline)
                    if p.followsYou { Text("Follows you").font(.caption).foregroundStyle(Color.brandRed) }
                }
                Spacer()
                if let follow {
                    if p.isFollowing {
                        Button { Task { await follow() } } label: { Label("Following", systemImage: "checkmark") }.buttonStyle(.bordered)
                    } else {
                        Button { Task { await follow() } } label: { Label("Follow", systemImage: "person.badge.plus") }.buttonStyle(.borderedProminent)
                    }
                }
            }
            if let followers = p.followers, let following = p.following {
                Picker("", selection: $tab) { Text("Followers").tag(0); Text("Following").tag(1) }.pickerStyle(.segmented)
                let people = tab == 0 ? followers : following, count = tab == 0 ? p.followersCount : p.followingCount
                if people.isEmpty && count == 0 { EmptyNote("Nobody yet.") }
                ForEach(people) { x in
                    Button { router.push(.user(x.id)) } label: {
                        HStack {
                            Avatar(url: x.avatarURL, name: x.name)
                            Text(x.name).font(.body).foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(.secondary)
                        }.padding(.vertical, 2)
                    }.buttonStyle(.plain)
                }
                if count > people.count { EmptyNote("+ \(count - people.count) you don't share a challenge with") }
            }
        }
    }
}

/// A profile: the header, then followers, then whatever the person's sharing level shows. Used for anyone, including me.
struct ProfileSections<Header: View>: View {
    @Environment(AppModel.self) private var model
    let p: Profile
    var follow: (() async -> Void)? = nil
    @ViewBuilder var header: Header
    var body: some View {
        let since: String = Day(p.memberSince).map { "Member since \($0.date.formatted(.dateTime.month(.wide).year()))" } ?? "Profile"
        Hero(eyebrow: since, title: p.name, trailing: { Avatar(url: p.avatarURL, name: p.name, size: 72) }, below: {
            if let bio = p.bio { Text(bio).foregroundStyle(.white.opacity(0.92)) }
        })
        header
        if let st = p.stats, !st.line.isEmpty { SectionCard { Text(st.line).font(.subheadline.weight(.semibold)) } }
        FollowCard(p: p, follow: follow)
        if let challenges = p.challenges {
            SectionCard(p.isSelf ? "My challenges" : "Challenges you share") {
                if challenges.isEmpty { EmptyNote("No challenges yet.") }
                ForEach(challenges, id: \.self) { c in
                    HStack {
                        VStack(alignment: .leading) {
                            Button(c.name) { model.openChallenge(c.id) }.font(.headline).buttonStyle(.plain).foregroundStyle(Color.brandRed)
                            Text([c.team, fmtRange(c.startDate, c.endDate)].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        VStack(alignment: .trailing) {
                            Text(fmtMeasure(c.measure, minutes: c.minutes, distance: c.distance, steps: c.steps, unit: c.distanceUnit)).font(.headline).foregroundStyle(Color.brandRed)
                            if c.rank > 0 { Text("\(ordinal(c.rank)) of \(c.of)").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
            }
            if let acts = p.activities {
                SectionCard("Recent activity") {
                    if acts.isEmpty { EmptyNote("Nothing logged yet.") }
                    ForEach(acts, id: \.self) { a in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(a.type).font(.headline)
                                Text([fmtDay(a.date), a.startTime].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                                Button(a.challengeName) { model.openChallenge(a.challengeId) }.font(.caption).buttonStyle(.plain).foregroundStyle(Color.brandRed)
                                if let c = a.comment { Text("“\(c)”").font(.caption) }
                            }
                            Spacer()
                            Text(fmtEntry(minutes: a.minutes, distance: a.distance, steps: a.steps, unit: a.distanceUnit, measure: a.measure)).bold()
                            if !p.isSelf && a.id > 0 { KudosButton(activityId: a.id, count: a.kudos, mine: a.kudosMine) } else if a.kudos > 0 { Text("👏 \(a.kudos)").font(.caption) }
                        }
                    }
                }
            }
        } else {
            SectionCard {
                Label(p.isSelf ? "Your profile is private: people only see your name and photo." : "\(p.name.components(separatedBy: " ").first ?? p.name) keeps their profile private.",
                      systemImage: "lock").foregroundStyle(.secondary)
            }
        }
    }
}

/// Someone else's profile (or mine), opened from a leaderboard.
struct UserProfileView: View {
    @Environment(AppModel.self) private var model
    let userId: Int
    @State private var profile: Profile?
    @State private var missing = false
    var body: some View {
        Page(refresh: load) {
            if let p = profile {
                let follow: (() async -> Void)? = p.isSelf ? nil : { await toggleFollow(p) }
                ProfileSections(p: p, follow: follow) { EmptyView() }
            }
            else if missing { SectionCard { EmptyNote("This profile isn't available.") } }
            else { ProgressView().frame(maxWidth: .infinity) }
        }
        .navigationTitle("Profile").navigationBarTitleDisplayMode(.inline)
        .task(id: userId) { await load() }
    }
    private func load() async {
        if let p = await model.call({ try await $0.profile(userId) }) { profile = p } else { missing = profile == nil }
    }
    private func toggleFollow(_ p: Profile) async {
        let done: Void? = await model.call { (api: API) async throws -> Void in
            if p.isFollowing { try await api.unfollow(p.id) } else { try await api.follow(p.id) }
        }
        if done != nil { await load() }
    }
}

/// Me: my profile exactly as challenge-mates see it, then settings.
struct MeView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @State private var profile: Profile?
    @State private var showPolicy = false

    var body: some View {
        Page(refresh: load) {
            if let p = profile {
                ProfileSections(p: p) {
                    HStack {
                        Label("How people in your challenges see you · sharing: \(sharingLabel(model.me?.sharing ?? "summary"))", systemImage: "eye").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button { router.push(.editProfile) } label: { Label("Edit", systemImage: "pencil") }.buttonStyle(.borderedProminent)
                    }
                }
            } else { ProgressView().frame(maxWidth: .infinity) }
            if model.update != nil { UpdateBanner() }
            if model.me?.adminNeedsTwoFactor == true {
                SectionCard {
                    Text("Turn on two-step sign-in to use the admin tools").font(.headline)
                    Text("Global admins can see and change everything, so signing in needs a code from your phone as well as your password. Set it up on the website: My account, Two-step sign-in.").font(.subheadline)
                }
            }
            SyncSettingsCard()
            if model.me?.isAdmin == true {
                Button { router.push(.admin) } label: { Label("Admin: users and challenges", systemImage: "person.badge.key").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).controlSize(.large)
            }
            Button { router.push(.help) } label: {
                Label("Help & feedback" + (model.helpBadge > 0 ? " (\(model.helpBadge) new)" : ""), systemImage: "questionmark.circle").frame(maxWidth: .infinity)
            }.buttonStyle(.bordered).controlSize(.large)
            Button(role: .destructive) { Task { await model.signOut() } } label: { Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right").frame(maxWidth: .infinity) }
                .buttonStyle(.bordered).controlSize(.large)
            Text("Active Together · \(serverURL.replacingOccurrences(of: "https://", with: "")) · version \(appVersion)").font(.caption).foregroundStyle(.secondary)
            Button("Privacy policy") { showPolicy = true }.font(.caption)
        }
        .navigationTitle("Active Together").navigationBarTitleDisplayMode(.inline)
        .task(id: model.me) { await load() }
        .sheet(isPresented: $showPolicy) { PolicyView() }
    }

    private func load() async {
        guard let m = model.me else { return }
        if let p = await model.call({ try await $0.profile(m.id) }) { profile = p }
    }
}

/// Automatic sync, routes and typing unit.
struct SyncSettingsCard: View {
    @Environment(AppModel.self) private var model
    @State private var autoSync = Prefs.autoSync
    @State private var routes = Prefs.includeRoutes
    @State private var unit = Prefs.preferredUnit

    var body: some View {
        SectionCard("Sync settings") {
            Toggle(isOn: $autoSync) {
                VStack(alignment: .leading) {
                    Text("Sync automatically").font(.headline)
                    Text("New workouts and steps sync when you open the app, and in the background when iOS allows (it chooses when, and only while the phone is unlocked). Workouts with no distance skip distance challenges.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .onChange(of: autoSync) { _, on in model.setAutoSync(on); if on { Task { await model.autoSyncNow() } } }
            Toggle(isOn: $routes) {
                VStack(alignment: .leading) {
                    Text("Include GPS routes").font(.headline)
                    Text("Upload each workout's route so you can see it on a map. Only you can see your routes.").font(.caption).foregroundStyle(.secondary)
                }
            }
            .onChange(of: routes) { _, on in
                Prefs.includeRoutes = on
                // Apple Health asks for routes as their own permission, once.
                if on { Task { try? await model.health.requestAccess(withRoutes: true) } }
            }
            Picker("Distance unit I type in", selection: $unit) { Text("Miles").tag("mi"); Text("Kilometres").tag("km") }
                .onChange(of: unit) { _, u in Prefs.preferredUnit = u }
        }
    }
}

/// Edit my profile: photo, name, bio, sharing level, email and password.
struct EditProfileView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @State private var name = ""
    @State private var bio = ""
    @State private var sharing = "summary"
    @State private var email = ""
    @State private var newPassword = ""
    @State private var currentPassword = ""
    @State private var busy = false
    @State private var note: String?
    @State private var photo: PhotosPickerItem?
    @State private var photoBusy = false
    @State private var deleting = false
    @State private var deletePassword = ""
    @State private var loaded = false

    private var sensitive: Bool { !newPassword.isEmpty || (model.me.map { email.trimmingCharacters(in: .whitespaces).lowercased() != $0.email.lowercased() } ?? false) }

    var body: some View {
        Form {
            Section("Photo") {
                HStack {
                    ZStack { Avatar(url: model.me?.avatarURL, name: model.me?.name ?? "?", size: 72); if photoBusy { ProgressView() } }
                    PhotosPicker(selection: $photo, matching: .images) { Label("Change photo", systemImage: "camera") }
                }
            }
            Section("About you") {
                TextField("Name", text: $name)
                TextField("About me (optional)", text: $bio, axis: .vertical).lineLimit(2...5)
                    .onChange(of: bio) { _, v in if v.count > 280 { bio = String(v.prefix(280)) } }
                Text("\(bio.count)/280").font(.caption).foregroundStyle(.secondary)
            }
            Section(header: Text("Who sees what"), footer: Text("Only people in a challenge with you can open your profile, and only for challenges you share. Leaderboard totals are always visible to them; GPS routes never are.")) {
                Picker("Sharing", selection: $sharing) {
                    ForEach(sharingLevels, id: \.code) { l in VStack(alignment: .leading) { Text(l.label); Text(l.detail).font(.caption) }.tag(l.code) }
                }.pickerStyle(.inline).labelsHidden()
            }
            Section(footer: Text("News about your challenges and tickets on this phone.")) {
                Toggle("Phone notifications", isOn: Binding(get: { model.me?.notifyPush ?? true }, set: { v in Task { await model.setNotifyPush(v) } }))
                if model.me?.notifyPush != false {
                    ForEach([("replies", "Replies to my tickets"), ("added", "Someone adds me to a challenge"), ("challenge", "Challenges starting and ending"), ("weekly", "My weekly summary"), ("kudos", "👏 on my activity")]
                            + (model.me?.isAdmin == true || model.me?.adminNeedsTwoFactor == true ? [("admin", "New support tickets and server errors")] : []), id: \.0) { k, label in
                        Toggle(label, isOn: Binding(get: { model.me?.pushPrefs[k] ?? true }, set: { v in Task { if let m = await model.call({ try await $0.setPushPrefs([k: v]) }) { model.me = m } } })).font(.subheadline)
                    }
                }
            }
            TwoStepSection()
            PasskeysSection()
            DevicesSection()
            Section("Sign-in details") {
                if let p = model.me?.pendingEmail { Text("Changing to \(p): open the link we sent there to finish.").font(.caption).foregroundStyle(.secondary) }
                TextField("Email", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("New password (leave blank to keep)", text: $newPassword)
                if sensitive { SecureField("Current password (needed to change email or password)", text: $currentPassword) }
            }
            if let note { Text(note).foregroundStyle(.red) }
            Button("Save") { save() }.bold()
                .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty || email.isEmpty || (sensitive && currentPassword.isEmpty))
            Section(header: Text("Delete my account"), footer: Text("Deletes your account, everything you've logged, your routes, follows and support tickets, straight away. A challenge you own alone passes to its longest-standing member, or is deleted if nobody else is in it. This can't be undone.")) {
                Button("Delete my account", role: .destructive) { deletePassword = ""; deleting = true }
            }
        }
        .navigationTitle("Edit profile").navigationBarTitleDisplayMode(.inline)
        .alert("Delete your account?", isPresented: $deleting) {
            if model.me?.hasPassword == false { TextField("Type DELETE", text: $deletePassword).textInputAutocapitalization(.characters) }
            else { SecureField("Password", text: $deletePassword) }
            Button("Delete account", role: .destructive) { let pw = deletePassword; Task { _ = await model.deleteAccount(password: pw) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text(model.me?.hasPassword == false ? "Everything in it is deleted for good. You sign in with Google or Apple, so type DELETE to confirm." : "Everything in it is deleted for good. Enter your password to confirm.") }
        .onAppear {
            guard !loaded, let me = model.me else { return }
            loaded = true; name = me.name; bio = me.bio ?? ""; sharing = me.sharing; email = me.email
        }
        .onChange(of: photo) { _, item in
            guard let item else { return }
            photoBusy = true
            Task {
                defer { photoBusy = false }
                guard let data = try? await item.loadTransferable(type: Data.self), let url = jpegDataURL(data, maxSide: 320) else { model.message = "Couldn't read that image"; return }
                guard let path = await model.call({ try await $0.uploadImage(dataURL: url) }) else { return }
                if let m = await model.call({ try await $0.updateProfile(avatarURL: path) }) { model.me = m; model.message = "Photo updated" }
            }
        }
    }

    private func save() {
        busy = true; note = nil
        let me = model.me
        let changedEmail = email.trimmingCharacters(in: .whitespaces)
        Task {
            let updated = await model.call {
                try await $0.updateProfile(name: name.trimmingCharacters(in: .whitespaces), email: changedEmail.lowercased() == me?.email.lowercased() ? nil : changedEmail,
                                           currentPassword: currentPassword, newPassword: newPassword, bio: bio.trimmingCharacters(in: .whitespaces), sharing: sharing)
            }
            busy = false
            if let updated { model.me = updated; Prefs.email = updated.email; model.message = updated.pendingEmail != nil && changedEmail.lowercased() != me?.email.lowercased() ? "Saved. Open the link we sent to \(updated.pendingEmail ?? "") to change your email" : "Profile saved"; router.pop() }
            else { note = model.message; model.message = nil }
        }
    }
}

/// Signed-in devices: each browser and phone signed in to my account, signing out any one, or all but this phone.
private struct DevicesSection: View {
    @Environment(AppModel.self) private var model
    @State private var list: [DeviceSession]?
    @State private var confirmAll = false
    var body: some View {
        Section("Signed-in devices") {
            if let list {
                ForEach(list) { d in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(d.device + (d.current ? " (this phone)" : "")).font(.subheadline.weight(.semibold))
                            Text("Signed in \(d.createdAt.prefix(10))" + (d.lastUsedAt.map { " · last used \($0.prefix(10))" } ?? "")).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if !d.current { Button("Sign out") { Task { if await model.call({ try await $0.signOutSession(d.id) }) != nil { await load() } } }.buttonStyle(.borderless) }
                    }
                }
                if list.count > 1 { Button("Sign out of all other devices", role: .destructive) { confirmAll = true } }
            } else { ProgressView() }
        }
        .task { await load() }
        .alert("Sign out everywhere else?", isPresented: $confirmAll) {
            Button("Sign out others", role: .destructive) { Task { if let n = await model.call({ try await $0.signOutOthers() }) { model.message = "Signed out of \(n) other device\(n == 1 ? "" : "s")"; await load() } } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Other phones and browsers are signed out. This phone stays signed in.") }
    }
    private func load() async { list = await model.call { try await $0.sessions() } }
}

/// Passkeys: sign in with Face ID or Touch ID instead of a password.
private struct PasskeysSection: View {
    @Environment(AppModel.self) private var model
    @State private var list: [Passkey]?
    @State private var error: String?
    var body: some View {
        Section(header: Text("Passkeys"), footer: Text("Sign in with Face ID or Touch ID instead of a password.")) {
            ForEach(list ?? []) { k in
                HStack {
                    VStack(alignment: .leading) {
                        Text(k.name).font(.subheadline.weight(.semibold))
                        Text("Added \(k.createdAt.prefix(10))" + (k.lastUsedAt.map { " · last used \($0.prefix(10))" } ?? "")).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Remove", role: .destructive) { Task { if await model.call({ try await $0.removePasskey(k.id) }) != nil { await load() } } }.buttonStyle(.borderless)
                }
            }
            Button("Add a passkey on this iPhone") { Task { error = await model.addPasskey(); if error == nil { await load() } } }
            if let error { Text(error).foregroundStyle(.red).font(.caption) }
        }
        .task { await load() }
    }
    private func load() async { list = await model.call { try await $0.passkeys() } }
}

/// Two-step sign-in: set it up with an authenticator app, keep the backup codes; new codes, or off.
private struct TwoStepSection: View {
    @Environment(AppModel.self) private var model
    @State private var setup: (secret: String, uri: String)?
    @State private var code = ""
    @State private var password = ""
    @State private var codes: [String]?
    var body: some View {
        Section("Two-step sign-in") {
            if let codes {
                Text("Your backup codes. Each works once instead of a code from the app, if you lose your phone. Keep them somewhere safe: they won't be shown again.").font(.subheadline)
                Text(codes.joined(separator: "\n")).font(.body.monospaced()).textSelection(.enabled)
                Button("Copy the codes") { UIPasteboard.general.string = codes.joined(separator: "\n"); model.message = "Copied" }
                Button("Done") { self.codes = nil; Task { await model.refreshMe() } }
            } else if model.me?.twoFactor == true {
                Text("On: signing in asks for a code from your authenticator app after your password.").font(.subheadline)
                if model.me?.hasPassword == false { Text("Set a password first to make new backup codes or switch this off.").font(.caption).foregroundStyle(.secondary) }
                else {
                    SecureField("Your password", text: $password)
                    Button("New backup codes") { Task { if let c = await model.call({ try await $0.twoStepNewBackupCodes(password: password) }) { codes = c; password = "" } } }.disabled(password.isEmpty)
                    Button("Turn off", role: .destructive) { Task { if await model.call({ try await $0.twoStepDisable(password: password) }) != nil { password = ""; await model.refreshMe(); model.message = "Two-step sign-in is off" } } }.disabled(password.isEmpty)
                }
            } else if let s = setup {
                Text("1. Add Active Together to an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password...):").font(.subheadline)
                if let u = URL(string: s.uri) { Link("Open in authenticator app", destination: u) }
                Button("Copy the key") { UIPasteboard.general.string = s.secret; model.message = "Copied" }
                Text(stride(from: 0, to: s.secret.count, by: 4).map { i in String(Array(s.secret)[i..<min(i + 4, s.secret.count)]) }.joined(separator: " ")).font(.caption.monospaced()).textSelection(.enabled)
                Text("2. Type the 6-digit code it shows:").font(.subheadline)
                TextField("Code", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode)
                Button("Turn on") { Task { if let c = await model.call({ try await $0.twoStepEnable(code) }) { codes = c; setup = nil; code = "" } } }.disabled(code.count != 6)
            } else {
                Text("Off. Turn it on so a stolen password isn't enough to sign in as you" + (model.me?.adminNeedsTwoFactor == true ? " - global admins need it for the admin tools." : ".")).font(.subheadline)
                Button("Set it up") { Task { if let s = await model.call({ try await $0.twoStepSetup() }) { setup = s } } }
            }
        }
    }
}
