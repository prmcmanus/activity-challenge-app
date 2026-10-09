import SwiftUI

@main
struct ActiveTogetherCompanionApp: App {
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

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Image(systemName: "figure.run.circle.fill").font(.system(size: 80)).foregroundStyle(.white, Color.brandYellow).padding(.top, 40)
                Text("Active Together").font(.largeTitle.weight(.heavy)).foregroundStyle(.white)
                Text("Sign in with your Active Together account to see your challenges, log activity and sync your workouts.")
                    .multilineTextAlignment(.center).foregroundStyle(.white.opacity(0.9))
                if let code = model.pendingInvite { InviteSignInCard(code: code) }
                VStack(spacing: 12) {
                    if let ticket {
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
                    Link("Forgot password?", destination: URL(string: "\(serverURL)/forgot")!).font(.footnote.bold())
                    Text("New here? Create an account at \(serverURL.replacingOccurrences(of: "https://", with: "")), then sign in.").font(.footnote).foregroundStyle(.secondary)
                    Link("Create an account", destination: URL(string: serverURL)!).font(.footnote.bold())
                    Link("Privacy policy", destination: URL(string: "\(serverURL)/privacy.html")!).font(.footnote)
                }
                .textFieldStyle(.roundedBorder)
                .padding(20).background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 20))
            }
            .padding(24)
        }
        .background(LinearGradient(colors: [.brandRedDeep, .brandRed, Color(.systemGroupedBackground)], startPoint: .top, endPoint: .bottom).ignoresSafeArea())
        .onAppear { if let m = model.message { error = m; model.message = nil } }
    }
}
