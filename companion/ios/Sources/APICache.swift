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
    static func put(_ token: String?, _ path: String, _ data: Data) { if let f = file(token, path) { try? data.write(to: f) } }
    static func get(_ token: String?, _ path: String) -> Data? { file(token, path).flatMap { try? Data(contentsOf: $0) } }
    static func clear() { if let d = dir { try? FileManager.default.removeItem(at: d) }; offline = false }
}
