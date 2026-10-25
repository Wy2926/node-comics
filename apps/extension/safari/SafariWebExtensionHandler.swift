import Foundation
import SafariServices

// Never log messages, responses or URLs. Source requests have no cookies or
// credentials and are separate from the public-client token exchange.
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        if let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any],
           (message["type"] as? String)?.hasPrefix("source-read-") == true {
            let profile = (item?.userInfo?[SFExtensionProfileKey] as? UUID)?.uuidString ?? "default"
            SourceReadBridge.handle(message, profile: profile, context: context)
            return
        }
        guard let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any],
              message["type"] as? String == "oidc-token",
              let endpoint = message["endpoint"] as? String,
              endpoint.utf8.count <= 4096,
              let url = URL(string: endpoint), url.user == nil, url.password == nil,
              url.fragment == nil, let host = url.host, !host.isEmpty,
              let body = message["body"] as? String, body.utf8.count <= 65536 else {
            reply(context, ["error": "invalid_request"]); return
        }
        var allowed = url.scheme == "https"
        #if DEBUG
        allowed = allowed || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(host))
        #endif
        let form = URLComponents(string: "https://localhost/?" + body)
        let grants = form?.queryItems?.filter { $0.name == "grant_type" } ?? []
        guard allowed, grants.count == 1,
              ["authorization_code", "refresh_token"].contains(grants[0].value ?? "") else {
            reply(context, ["error": "invalid_request"]); return
        }
        TokenExchange(context: context).start(url: url, body: body)
    }
}

private func reply(_ context: NSExtensionContext, _ message: [String: Any]) {
    let response = NSExtensionItem()
    response.userInfo = [SFExtensionMessageKey: message]
    context.completeRequest(returningItems: [response], completionHandler: nil)
}

// URLSession owns this delegate until invalidation. A serial delegate queue
// bounds each response to 128 KiB, including servers without Content-Length.
private final class TokenExchange: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let context: NSExtensionContext
    private var session: URLSession?
    private var data = Data()
    private var status = 0
    private var rejected = false
    private let limit = 131072

    init(context: NSExtensionContext) { self.context = context }

    func start(url: URL, body: String) {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 20
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(body.utf8)
        session.dataTask(with: request).resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // Never send authorization codes or refresh tokens to a redirect target.
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse,
              (200...599).contains(http.statusCode), response.expectedContentLength <= limit else {
            rejected = true; completionHandler(.cancel); return
        }
        status = http.statusCode
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        guard data.count + chunk.count <= limit else { rejected = true; dataTask.cancel(); return }
        data.append(chunk)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer { session.invalidateAndCancel(); self.session = nil }
        guard error == nil, !rejected, let body = String(data: data, encoding: .utf8) else {
            reply(context, ["error": "transport_failed"]); return
        }
        reply(context, ["status": status, "body": body])
    }
}

// Public source bytes cross this bridge in chunks below 1 MiB per message.
// Temporary files survive native suspension; later calls remove stale files.
private enum SourceReadBridge {
    static let limit = 32 * 1024 * 1024, chunk = 512 * 1024
    static let lock = NSLock()
    nonisolated(unsafe) static var active: [String: URLSessionTask] = [:]

    static func handle(_ message: [String: Any], profile: String, context: NSExtensionContext) {
        guard let rawID = message["id"] as? String, let id = UUID(uuidString: rawID),
              rawID.lowercased() == id.uuidString.lowercased() else {
            reply(context, ["error": "invalid_request"]); return
        }
        let manager = FileManager.default
        let directory = manager.temporaryDirectory.appendingPathComponent("nodelane-source-" + profile, isDirectory: true)
        let file = directory.appendingPathComponent(id.uuidString)
        let key = profile + ":" + id.uuidString
        do {
            try manager.createDirectory(at: directory, withIntermediateDirectories: true,
                                        attributes: [.posixPermissions: 0o700])
            // Bound disk use even if the web page or native process was killed.
            let files = try manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])
            for entry in files {
                // Another completed transfer can remove this file during enumeration.
                let date = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                if date.timeIntervalSinceNow < -120 { try? manager.removeItem(at: entry) }
            }
            switch message["type"] as? String {
            case "source-read-close":
                lock.lock(); let task = active[key]; lock.unlock()
                task?.cancel()
                try? manager.removeItem(at: file)
                reply(context, ["closed": true])
            case "source-read-read":
                guard let offset = message["offset"] as? Int, offset >= 0, offset < limit,
                      offset % chunk == 0 else { reply(context, ["error": "invalid_request"]); return }
                let handle = try FileHandle(forReadingFrom: file)
                defer { try? handle.close() }
                try handle.seek(toOffset: UInt64(offset))
                let data = try handle.read(upToCount: chunk) ?? Data()
                reply(context, ["data": data.base64EncodedString()])
            case "source-read-open":
                guard let address = message["url"] as? String, address.utf8.count <= 16384,
                      let url = URL(string: address), valid(url),
                      let referer = message["referer"] as? String, referer.utf8.count <= 4096,
                      !referer.contains("\r"), !referer.contains("\n"),
                      referer.isEmpty || (URL(string: referer).map { valid($0, allowHTTP: true) } ?? false),
                      let kind = message["kind"] as? String, ["image", "text"].contains(kind),
                      reserve(file: file, directory: directory, key: key) else {
                    reply(context, ["error": "invalid_request"]); return
                }
                try SourceReadExchange(context: context, file: file, key: key, text: kind == "text").start(url: url, referer: referer)
            default: reply(context, ["error": "invalid_request"])
            }
        } catch {
            try? manager.removeItem(at: file)
            reply(context, ["error": "transport_failed"])
        }
    }

    private static func reserve(file: URL, directory: URL, key: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let manager = FileManager.default
        guard active[key] == nil, !manager.fileExists(atPath: file.path),
              let count = try? manager.contentsOfDirectory(atPath: directory.path).count, count < 4 else { return false }
        return manager.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
    }

    static func valid(_ url: URL, allowHTTP: Bool = false) -> Bool {
        guard let host = url.host, !host.isEmpty, url.user == nil, url.password == nil, url.fragment == nil else { return false }
        if url.scheme == "https" { return true }
        #if DEBUG
        if url.scheme == "http" && ["localhost", "127.0.0.1"].contains(host) { return true }
        #endif
        return allowHTTP && url.scheme == "http"
    }
}

private final class SourceReadExchange: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let context: NSExtensionContext, file: URL, key: String
    private let text: Bool
    private var limit: Int { text ? 8 * 1024 * 1024 : SourceReadBridge.limit }
    private var handle: FileHandle?
    private var size = 0, status = 0
    private var headers: [String: String] = [:]
    private var failed = false, headOnly = false

    init(context: NSExtensionContext, file: URL, key: String, text: Bool) {
        self.context = context; self.file = file; self.key = key; self.text = text
    }

    func start(url: URL, referer: String) throws {
        handle = try FileHandle(forWritingTo: file)
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil; config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 25
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        var request = URLRequest(url: url)
        if !referer.isEmpty { request.setValue(referer, forHTTPHeaderField: "Referer") }
        let task = session.dataTask(with: request)
        SourceReadBridge.lock.lock(); SourceReadBridge.active[key] = task; SourceReadBridge.lock.unlock()
        task.resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // JavaScript must authorize each hop and recompute the source Referer.
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust
                          ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, (200...599).contains(http.statusCode) else {
            failed = true; completionHandler(.cancel); return
        }
        status = http.statusCode
        for name in ["content-type", "location", "cf-mitigated", "retry-after"] {
            if let value = http.value(forHTTPHeaderField: name), value.utf8.count <= 16384 { headers[name] = value }
        }
        if !(200...299).contains(status) || headers["cf-mitigated"] == "challenge" {
            headOnly = true; completionHandler(.cancel); return
        }
        let mime = (headers["content-type"] ?? "").lowercased().components(separatedBy: ";")[0]
        let allowedType = text ? (mime.hasPrefix("text/") || ["application/json", "application/javascript", "application/x-javascript", "application/octet-stream"].contains(mime))
                               : (mime.hasPrefix("image/") || mime == "application/octet-stream")
        guard allowedType, response.expectedContentLength <= limit else {
            failed = true; completionHandler(.cancel); return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard size + data.count <= limit else { failed = true; dataTask.cancel(); return }
        do { try handle?.write(contentsOf: data); size += data.count }
        catch { failed = true; dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        try? handle?.close(); handle = nil
        SourceReadBridge.lock.lock(); SourceReadBridge.active.removeValue(forKey: key); SourceReadBridge.lock.unlock()
        session.finishTasksAndInvalidate()
        if headOnly {
            try? FileManager.default.removeItem(at: file)
            reply(context, ["status": status, "headers": headers, "length": 0])
        } else if failed || error != nil || (!text && size == 0) {
            try? FileManager.default.removeItem(at: file)
            reply(context, ["error": "transport_failed"])
        } else {
            reply(context, ["status": status, "headers": headers, "length": size])
        }
    }
}
