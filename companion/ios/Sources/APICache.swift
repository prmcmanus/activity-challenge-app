import Foundation
import CryptoKit

/// The last answer to each signed-in read, kept in the app's caches folder (per account), and whether the app is showing
/// kept answers because there's no connection.
enum APICache {
    static var offline = false
    private static var dir: URL? {
        guard let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let d = base.appendingPathComponent("api", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    private static func file(_ token: String?, _ path: String) -> URL? {
        let key = SHA256.hash(data: Data("\(token ?? "")|\(path)".utf8)).map { String(format: "%02x", $0) }.joined()
        return dir?.appendingPathComponent(key)
    }
    static func put(_ token: String?, _ path: String, _ data: Data) { if let f = file(token, path) { try? data.write(to: f); prune() } }
    /// At most 200 answers, none older than 30 days; a new version of the app starts afresh.
    private static func prune() {
        guard let d = dir, let files = try? FileManager.default.contentsOfDirectory(at: d, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let dated = files.filter { $0.lastPathComponent != "version" }.map { ($0, (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        let old = Date().addingTimeInterval(-30 * 86400)
        for (f, when) in dated where when < old { try? FileManager.default.removeItem(at: f) }
        for (f, _) in dated.filter({ $0.1 >= old }).sorted(by: { $0.1 > $1.1 }).dropFirst(200) { try? FileManager.default.removeItem(at: f) }
    }
    /// Run once at start-up: answers kept by another version of the app are dropped.
    static func checkVersion() {
        guard let d = dir else { return }
        let stamp = d.appendingPathComponent("version"), v = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? ""
        if (try? String(contentsOf: stamp, encoding: .utf8)) != v { clear(); if let d2 = dir { try? v.write(to: d2.appendingPathComponent("version"), atomically: true, encoding: .utf8) } }
    }
    static func get(_ token: String?, _ path: String) -> Data? { file(token, path).flatMap { try? Data(contentsOf: $0) } }
    static func clear() { if let d = dir { try? FileManager.default.removeItem(at: d) }; offline = false }
}
