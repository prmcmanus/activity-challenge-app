import SwiftUI

@main
struct ActiveTogetherCompanionApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    init() { BackgroundSync.register() }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(.brandRed)
                // Invite links: activetogether://join/CODE (and https://activetogether.team/join/CODE where the system routes it here).
                .onOpenURL { model.openLink($0) }
                .onAppear { AppDelegate.model = model }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { a in if let u = a.webpageURL { model.openLink(u) } }
        }
        .onChange(of: phase) { _, p in if p == .background { BackgroundSync.schedule() } }
    }
}

/// Every page that can be pushed onto a tab's stack.
enum Route: Hashable {
    case challenge(Int), editChallenge(Int), newChallenge, join, invite(String)
    case activity(Int), editActivity(Int), log
    case user(Int), editProfile, help, newTicket, ticket(Int), support, admin
    case members(Int), manageTeam(Int, Int)
}

enum Tab: Hashable { case challenges, activity, sync, me }

@Observable final class Router {
    var tab: Tab = .challenges
    var paths: [Tab: [Route]] = [.challenges: [], .activity: [], .sync: [], .me: []]
    func push(_ r: Route) { paths[tab, default: []].append(r) }
    func pop() { _ = paths[tab]?.popLast() }
    func popToRoot() { paths[tab] = [] }
    func binding(_ t: Tab) -> Binding<[Route]> { Binding(get: { self.paths[t] ?? [] }, set: { self.paths[t] = $0 }) }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var router = Router()

    var body: some View {
        Group {
            if !model.signedIn { LoginView() }
            else {
                TabView(selection: $router.tab) {
                    stack(.challenges) { ChallengesView() }.tabItem { Label("Challenges", systemImage: "trophy") }.tag(Tab.challenges)
                    stack(.activity) { ActivityListView() }.tabItem { Label("Activity", systemImage: "figure.run") }.tag(Tab.activity)
                    stack(.sync) { SyncView() }.tabItem { Label("Sync", systemImage: "arrow.triangle.2.circlepath") }.tag(Tab.sync)
                    stack(.me) { MeView() }.tabItem { Label("Me", systemImage: "person.crop.circle") }.tag(Tab.me)
                }
                // A tapped notification opens its challenge or ticket.
                .task(id: model.pendingRoute) {
                    guard let url = model.pendingRoute else { return }
                    model.pendingRoute = nil
                    let parts = url.split(separator: "/").map(String.init)
                    if parts.count == 2, parts[0] == "challenges", let id = Int(parts[1]) { if router.tab == .challenges { router.push(.challenge(id)) } else { router.tab = .challenges; router.paths[.challenges] = [.challenge(id)] } }
                    else if parts.count == 3, parts[0] == "help", parts[1] == "tickets", let id = Int(parts[2]) { router.tab = .me; router.paths[.me] = [.ticket(id)] }
                    else if parts.count == 2, parts[0] == "users", let id = Int(parts[1]) { router.push(.user(id)) }
                }
                // Without a connection the app shows what it last loaded, and says so.
                .safeAreaInset(edge: .top) {
                    if model.offline || model.pendingLogs > 0 {
                        Text([model.offline ? "Offline: showing what was last loaded." : nil, model.pendingLogs > 0 ? "\(model.pendingLogs) activit\(model.pendingLogs == 1 ? "y" : "ies") waiting to be sent." : nil]
                            .compactMap { $0 }.joined(separator: " ")).font(.caption).frame(maxWidth: .infinity).padding(6).background(Color.brandYellow.opacity(0.35))
                    }
                }
                // An invite link (opened now, or before signing in) goes to its confirm screen.
                .task(id: model.pendingInvite) {
                    if let code = model.pendingInvite { router.tab = .challenges; router.paths[.challenges] = [.invite(code)] }
                }
            }
        }
        .environment(router)
        .modifier(Toast(model: model))
    }

    private func stack<Content: View>(_ t: Tab, @ViewBuilder _ root: () -> Content) -> some View {
        NavigationStack(path: router.binding(t)) {
            root()
                .toolbar { topBar() }
                .navigationDestination(for: Route.self) { destination($0) }
        }
    }

    /// Help (with its badge) on every main screen; refresh on the lists.
    @ToolbarContentBuilder private func topBar() -> some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if router.tab == .challenges || router.tab == .activity {
                Button { Task { await model.refreshTop() } } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(model.topRefreshing).accessibilityLabel("Refresh")
            }
            Button { router.push(.help) } label: {
                Image(systemName: "questionmark.circle")
                    .overlay(alignment: .topTrailing) {
                        if model.helpBadge > 0 {
                            Text("\(model.helpBadge)").font(.caption2.bold()).foregroundStyle(.white).padding(3).background(Color.brandRed, in: Circle()).offset(x: 8, y: -8)
                        }
                    }
            }.accessibilityLabel("Help")
        }
    }

    @ViewBuilder private func destination(_ r: Route) -> some View {
        switch r {
        case .challenge(let id): ChallengeDetailView(challengeId: id)
        case .editChallenge(let id): ChallengeFormView(challengeId: id)
        case .newChallenge: ChallengeFormView(challengeId: nil)
        case .join: JoinView()
        case .invite(let code): InviteView(code: code)
        case .activity(let id): ActivityDetailView(activityId: id)
        case .editActivity(let id): EditActivityView(activityId: id)
        case .log: LogActivityView()
        case .user(let id): UserProfileView(userId: id)
        case .editProfile: EditProfileView()
        case .help: HelpView()
        case .newTicket: NewTicketView()
        case .ticket(let id): TicketView(ticketId: id)
        case .support: SupportDashboardView()
        case .admin: AdminView()
        case .members(let id): ChallengeMembersView(challengeId: id)
        case .manageTeam(let c, let t): TeamManageView(challengeId: c, teamId: t)
        }
    }
}

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var email = Prefs.email
    @State private var password = ""
    @State private var ticket: String?
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?
    // Creating an account rather than signing in (from the link below, or an invite card); the privacy policy sheet.
    @State private var creating = false
    @State private var showPolicy = false
    @State private var forgot = false
    // Google / Apple: a sign-in waiting for an invite code (signing up on an invite-only site).
    @State private var waiting: (provider: String, token: String, name: String?)?
    @State private var socialInvite = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Image(systemName: "figure.run.circle.fill").font(.system(size: 80)).foregroundStyle(.white, Color.brandYellow).padding(.top, 40)
                Text("Active Together").font(.largeTitle.weight(.heavy)).foregroundStyle(.white)
                Text(creating ? "Create your Active Together account to join challenges, log activity and sync your workouts."
                     : "Sign in with your Active Together account to see your challenges, log activity and sync your workouts.")
                    .multilineTextAlignment(.center).foregroundStyle(.white.opacity(0.9))
                if let code = model.pendingInvite { InviteSignInCard(code: code, creating: creating) { creating = true } }
                VStack(spacing: 12) {
                    if let w = waiting {
                        Text("Your invite code").font(.title3.bold()).frame(maxWidth: .infinity, alignment: .leading)
                        if let error { Text(error).font(.subheadline) }
                        TextField("Invite code", text: $socialInvite).textInputAutocapitalization(.characters).autocorrectionDisabled()
                        Button { social(w.provider, w.token, w.name, invite: socialInvite.trimmingCharacters(in: .whitespaces).uppercased()) } label: {
                            Group { if busy { ProgressView().tint(.white) } else { Text("Create my account").bold() } }.frame(maxWidth: .infinity)
                        }.buttonStyle(.borderedProminent).controlSize(.large).disabled(busy || socialInvite.trimmingCharacters(in: .whitespaces).isEmpty)
                        Button("Back") { waiting = nil; error = nil }.font(.footnote)
                    } else if creating {
                        CreateAccountForm(onSocial: { social($0, $1, $2, invite: model.pendingInvite) }) { creating = false }
                    } else if let ticket {
                        // Two-step sign-in: the code from the authenticator app, or a backup code.
                        Text("Enter the 6-digit code from your authenticator app, or one of your backup codes.").font(.subheadline)
                        TextField("Code", text: $code).textContentType(.oneTimeCode).textInputAutocapitalization(.characters).autocorrectionDisabled()
                        Button("Start again") { self.ticket = nil; code = ""; error = nil }.font(.footnote)
                        if let error { Text(error).foregroundStyle(.red).font(.subheadline) }
                        Button {
                            busy = true; error = nil
                            Task { error = await model.signInCode(ticket: ticket, code: code); busy = false; if error == nil { code = ""; self.ticket = nil } }
                        } label: { Group { if busy { ProgressView().tint(.white) } else { Text("Sign in").bold() } }.frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                        .disabled(busy || code.trimmingCharacters(in: .whitespaces).isEmpty)
                    } else {
                        SocialButtons { social($0, $1, $2, invite: model.pendingInvite) }
                        TextField("Email", text: $email).textContentType(.username).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                        SecureField("Password", text: $password).textContentType(.password)
                        if let error { Text(error).foregroundStyle(.red).font(.subheadline) }
                        Button {
                            busy = true; error = nil
                            Task {
                                let r = await model.signIn(email: email, password: password)
                                error = r.error; busy = false
                                if r.error == nil { password = "" }
                                if let next = r.ticket { ticket = next }
                            }
                        } label: { Group { if busy { ProgressView().tint(.white) } else { Text("Sign in").bold() } }.frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                        .disabled(busy || email.isEmpty || password.isEmpty)
                    }
                    if !creating && waiting == nil {
                        if ticket == nil {
                            Button { busy = true; error = nil; Task { error = await model.passkeySignIn(); busy = false } } label: { Label("Sign in with a passkey", systemImage: "person.badge.key").frame(maxWidth: .infinity) }
                                .buttonStyle(.bordered).disabled(busy)
                        }
                        Button("Forgot password?") { forgot = true }.font(.footnote.bold())
                        Button("New here? Create an account") { creating = true; error = nil }.font(.footnote.bold())
                        Button("Privacy policy") { showPolicy = true }.font(.footnote)
                    }
                }
                .textFieldStyle(.roundedBorder)
                .padding(20).background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 20))
            }
            .padding(24)
        }
        .background(LinearGradient(colors: [.brandRedDeep, .brandRed, Color(.systemGroupedBackground)], startPoint: .top, endPoint: .bottom).ignoresSafeArea())
        .onAppear { if let m = model.message { error = m; model.message = nil } }
        .sheet(isPresented: $showPolicy) { PolicyView() }
        .sheet(isPresented: $forgot) { ForgotPasswordView(start: email) }
    }

    /// Hand Google's or Apple's token to the server: signed in, or the two-step code, or the invite code first.
    private func social(_ provider: String, _ token: String, _ name: String?, invite: String?) {
        busy = true; error = nil
        Task {
            let r = await model.socialSignIn(provider: provider, credential: token, name: name, inviteCode: invite)
            busy = false; error = r.error
            if r.inviteNeeded { waiting = (provider, token, name) } else { waiting = nil; if let next = r.ticket { ticket = next } }
        }
    }
}

/// A link to choose a new password, emailed (it opens the website, which finishes the reset).
struct ForgotPasswordView: View {
    @Environment(\.dismiss) private var dismiss
    @State var start: String
    @State private var sent = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                if sent { Text("If an account uses that address, a link to choose a new password is on its way. It works for an hour. Nothing after a few minutes? Check your spam folder.") }
                else {
                    Text("Enter your email and we'll send you a link to choose a new password.")
                    TextField("Email", text: $start).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle(sent ? "Check your email" : "Forgot your password?").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(sent ? "Done" : "Cancel") { dismiss() } }
                if !sent { ToolbarItem(placement: .confirmationAction) { Button("Send") { Task { do { try await API(token: nil).forgotPassword(start); sent = true } catch { self.error = (error as? APIError)?.message ?? error.localizedDescription } } }.disabled(!start.contains("@")) } }
            }
        }
    }
}
