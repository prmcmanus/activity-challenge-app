import SwiftUI
import UIKit

// The web app's palette: signal red with a sunshine-yellow accent.
extension Color {
    static let brandRed = Color(red: 0xD4 / 255, green: 0x05 / 255, blue: 0x11 / 255)
    static let brandRedDeep = Color(red: 0xB7 / 255, green: 0x04 / 255, blue: 0x0E / 255)
    static let brandYellow = Color(red: 1, green: 0xCC / 255, blue: 0)
}

// MARK: - Formatting

func fmtNum(_ v: Double) -> String {
    v == v.rounded() ? String(Int(v)) : String(format: "%.2f", v).replacingOccurrences(of: #"\.?0+$"#, with: "", options: .regularExpression)
}
func fmtSteps(_ n: Double) -> String { Int(n).formatted(.number) }
func fmtSteps(_ n: Int) -> String { n.formatted(.number) }
func unitShort(_ u: String) -> String { u == "km" ? "km" : "mi" }
func unitLong(_ u: String) -> String { u == "km" ? "km" : "miles" }
func fmtMeasure(_ m: Measure, minutes: Double, distance: Double, steps: Double, unit: String) -> String {
    switch m {
    case .steps: "\(fmtSteps(steps)) steps"
    case .distance: "\(fmtNum(distance)) \(unitShort(unit))"
    case .minutes: "\(fmtNum(minutes)) min"
    }
}
func measureLabel(_ m: Measure, unit: String) -> String {
    switch m { case .steps: "Steps"; case .distance: unit == "km" ? "Kilometres" : "Miles"; case .minutes: "Active minutes" }
}
/// "3.1 mi · 28 min" - the challenge's own measure first; a step entry is just its steps.
func fmtEntry(minutes: Double?, distance: Double?, steps: Int?, unit: String, measure: Measure) -> String {
    if let steps, measure == .steps || (minutes == nil && distance == nil) { return "\(fmtSteps(steps)) steps" }
    let d = distance.map { "\(fmtNum($0)) \(unitShort(unit))" }, m = minutes.map { "\(fmtNum($0)) min" }
    return (measure == .distance ? [d, m] : [m, d]).compactMap { $0 }.joined(separator: " · ")
}
func fmtEntry(_ a: MyActivity) -> String { fmtEntry(minutes: a.minutes, distance: a.distance, steps: a.steps, unit: a.distanceUnit, measure: a.measure) }

func fmtDay(_ d: Day) -> String { d.date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)) }
func fmtRange(_ a: Day, _ b: Day) -> String {
    let f = Date.FormatStyle().day().month(.abbreviated)
    return "\(a.date.formatted(f)) – \(b.date.formatted(f.year()))"
}
func stateLabel(_ start: Day, _ end: Day) -> String {
    let today = Day.today
    if today < start { return "Starts \(fmtDay(start))" }
    if today > end { return "Finished" }
    let days = Calendar.current.dateComponents([.day], from: today.date, to: end.date).day ?? 0
    return "\(days + 1) days left"
}
/// Server times are UTC "YYYY-MM-DD HH:MM:SS[.mmm]"; shown in local time.
func fmtWhen(_ s: String) -> String {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss"; f.timeZone = TimeZone(identifier: "UTC"); f.locale = Locale(identifier: "en_US_POSIX")
    guard let d = f.date(from: String(s.prefix(19)).replacingOccurrences(of: "T", with: " ")) else { return s }
    return d.formatted(.dateTime.day().month(.abbreviated).hour().minute())
}
func htmlToText(_ html: String) -> String {
    html.replacingOccurrences(of: "</p>", with: "\n").replacingOccurrences(of: "<br>", with: "\n").replacingOccurrences(of: "</li>", with: "\n")
        .replacingOccurrences(of: "<li>", with: "• ").replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        .replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
        .replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&#39;", with: "'").replacingOccurrences(of: "&nbsp;", with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}
func ordinal(_ n: Int) -> String {
    let suffix = (11...13).contains(n % 100) ? "th" : n % 10 == 1 ? "st" : n % 10 == 2 ? "nd" : n % 10 == 3 ? "rd" : "th"
    return "\(n)\(suffix)"
}
var appVersion: String { (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "?" }

// MARK: - Building blocks

/// The red banner at the top of a page, matching the web app's hero.
struct Hero<Trailing: View, Below: View>: View {
    let eyebrow: String, title: String
    @ViewBuilder var trailing: Trailing
    @ViewBuilder var below: Below
    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text(eyebrow.uppercased()).font(.caption2.weight(.bold)).tracking(1.4).foregroundStyle(.white.opacity(0.85))
                Text(title).font(.title.weight(.heavy)).foregroundStyle(.white)
                below
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(LinearGradient(colors: [.brandRedDeep, .brandRed], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 20))
    }
}
extension Hero where Trailing == EmptyView, Below == EmptyView {
    init(_ eyebrow: String, _ title: String) { self.init(eyebrow: eyebrow, title: title, trailing: { EmptyView() }, below: { EmptyView() }) }
}
extension Hero where Trailing == EmptyView {
    init(_ eyebrow: String, _ title: String, @ViewBuilder below: () -> Below) { self.init(eyebrow: eyebrow, title: title, trailing: { EmptyView() }, below: below) }
}

/// The big number in the hero, e.g. "15.6 / my miles".
struct HeroStat: View {
    let value: String, label: String
    var body: some View {
        VStack(spacing: 2) {
            Text(value).font(.system(size: 28, weight: .heavy)).foregroundStyle(.white).minimumScaleFactor(0.5).lineLimit(1)
            Text(label).font(.caption).foregroundStyle(.white)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(.white.opacity(0.14), in: RoundedRectangle(cornerRadius: 14))
    }
}

struct SectionCard<Content: View, Action: View>: View {
    var title: String? = nil
    @ViewBuilder var action: Action
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title {
                HStack { Text(title).font(.title3.bold()); Spacer(); action }
            }
            content
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
    }
}
extension SectionCard where Action == EmptyView {
    init(_ title: String? = nil, @ViewBuilder content: () -> Content) { self.init(title: title, action: { EmptyView() }, content: content) }
}

/// An uploaded avatar or logo, or the first letter on yellow - as on the web leaderboards.
struct Avatar: View {
    let url: String?, name: String
    var size: CGFloat = 36
    var body: some View {
        Group {
            if let u = serverURLFor(url) {
                AsyncImage(url: u) { img in img.resizable().scaledToFill() } placeholder: { letter }
            } else { letter }
        }
        .frame(width: size, height: size).clipShape(Circle())
    }
    private var letter: some View {
        ZStack { Color.brandYellow; Text(String(name.prefix(1)).uppercased()).font(.system(size: size * 0.42, weight: .heavy)).foregroundStyle(Color.brandRed) }
    }
}

struct EmptyNote: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).font(.subheadline).foregroundStyle(.secondary) }
}

struct Pill: View {
    let text: String, background: Color, foreground: Color
    var body: some View {
        Text(text).font(.caption.bold()).foregroundStyle(foreground).padding(.horizontal, 8).padding(.vertical, 3)
            .background(background, in: RoundedRectangle(cornerRadius: 8))
    }
}

/// A scrolling page of cards on the grouped background, with pull-to-refresh when given an action.
struct Page<Content: View>: View {
    var refresh: (() async -> Void)? = nil
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) { content }.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 24)
        }
        .background(Color(.systemGroupedBackground))
        .refreshable { await refresh?() }
    }
}

/// Shrink a picked image to a JPEG data: URL - the same sizes the web app sends.
func jpegDataURL(_ data: Data, maxSide: CGFloat, quality: CGFloat = 0.85) -> String? {
    guard let img = UIImage(data: data) else { return nil }
    let scale = min(1, maxSide / max(img.size.width, img.size.height))
    let size = CGSize(width: img.size.width * scale, height: img.size.height * scale)
    let out = UIGraphicsImageRenderer(size: size).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
    return out.jpegData(compressionQuality: quality).map { "data:image/jpeg;base64," + $0.base64EncodedString() }
}

/// A one-line status message from the model, shown briefly at the bottom of the screen.
struct Toast: ViewModifier {
    @Bindable var model: AppModel
    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let m = model.message {
                Text(m).font(.subheadline).foregroundStyle(.white).padding(.horizontal, 16).padding(.vertical, 12)
                    .background(Color(white: 0.15), in: RoundedRectangle(cornerRadius: 12)).padding(.horizontal, 16).padding(.bottom, 70)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task(id: m) { try? await Task.sleep(for: .seconds(3)); if model.message == m { withAnimation { model.message = nil } } }
                    .onTapGesture { model.message = nil }
            }
        }
        .animation(.default, value: model.message)
    }
}
