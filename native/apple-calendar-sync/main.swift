import AppKit
import EventKit
import Foundation

private let testCalendarTitle = "yCal · Test"
private let testEventTitle = "yCal iCloud mirror test"

private struct SourceInfo: Codable {
    let id: String
    let title: String
    let type: String
    let isICloudCandidate: Bool
}

private struct StatusPayload: Codable {
    let supported: Bool
    let authorization: String
    let sources: [SourceInfo]
    let testCalendarSourceIds: [String]
}

private struct MutationPayload: Codable {
    let status: StatusPayload
    let calendarIdentifier: String?
    let eventIdentifier: String?
}

private struct MirrorEventInput: Codable {
    let key: String
    let color: String
    let title: String
    let startMs: Double
    let endMs: Double
    let allDay: Bool
    let location: String?
    let notes: String?
}

private struct MirrorSyncInput: Codable {
    let rangeStartMs: Double
    let rangeEndMs: Double
    let events: [MirrorEventInput]
}

private struct MirrorSyncResult: Codable {
    let status: StatusPayload
    let rangeStart: String
    let rangeEnd: String
    let sourceEventCount: Int
    let calendarsCreated: Int
    let eventsCreated: Int
    let eventsUpdated: Int
    let eventsMoved: Int
    let eventsDeleted: Int
}

private struct ErrorPayload: Codable {
    let error: String
}

private enum HelperError: LocalizedError {
    case usage
    case accessDenied
    case missingSource(String)
    case sourceCannotCreateCalendar(String)
    case invalidMirrorPayload(String)

    var errorDescription: String? {
        switch self {
        case .usage:
            return "Usage: apple-calendar-sync probe|request-access|create-spike|remove-spike [source-id] | sync-mirror <source-id> <payload.json>"
        case .accessDenied:
            return "Calendar access was not granted. Enable yCal in System Settings → Privacy & Security → Calendars."
        case .missingSource(let id):
            return "The selected EventKit source is no longer available: \(id)"
        case .sourceCannotCreateCalendar(let title):
            return "Could not create a calendar in \(title). Select a writable iCloud calendar source."
        case .invalidMirrorPayload(let detail):
            return "Invalid Apple Calendar mirror payload: \(detail)"
        }
    }
}

private func authorizationName() -> String {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(macOS 14.0, *) {
        switch status {
        case .fullAccess: return "fullAccess"
        case .writeOnly: return "writeOnly"
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorized: return "authorized"
        @unknown default: return "unknown"
        }
    }
    switch status {
    case .authorized: return "authorized"
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    default: return "unknown"
    }
}

private func hasFullAccess() -> Bool {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(macOS 14.0, *) {
        return status == .fullAccess
    }
    return status == .authorized
}

private func requestAccess(_ store: EKEventStore) async throws -> Bool {
    if #available(macOS 14.0, *) {
        return try await store.requestFullAccessToEvents()
    }
    return try await withCheckedThrowingContinuation { continuation in
        store.requestAccess(to: .event) { granted, error in
            if let error {
                continuation.resume(throwing: error)
            } else {
                continuation.resume(returning: granted)
            }
        }
    }
}

private func sourceTypeName(_ type: EKSourceType) -> String {
    switch type {
    case .local: return "local"
    case .exchange: return "exchange"
    case .calDAV: return "calDAV"
    case .mobileMe: return "mobileMe"
    case .subscribed: return "subscribed"
    case .birthdays: return "birthdays"
    @unknown default: return "unknown"
    }
}

private func isICloudCandidate(_ source: EKSource) -> Bool {
    let normalized = source.title.folding(
        options: [.caseInsensitive, .diacriticInsensitive],
        locale: .current
    )
    return (source.sourceType == .calDAV || source.sourceType == .mobileMe)
        && normalized.localizedCaseInsensitiveContains("icloud")
}

private func statusPayload(_ store: EKEventStore) -> StatusPayload {
    guard hasFullAccess() else {
        return StatusPayload(
            supported: true,
            authorization: authorizationName(),
            sources: [],
            testCalendarSourceIds: []
        )
    }

    let sources = store.sources
        .filter { source in
            source.sourceType != .birthdays && source.sourceType != .subscribed
        }
        .map { source in
            SourceInfo(
                id: source.sourceIdentifier,
                title: source.title,
                type: sourceTypeName(source.sourceType),
                isICloudCandidate: isICloudCandidate(source)
            )
        }
        .sorted { lhs, rhs in
            if lhs.isICloudCandidate != rhs.isICloudCandidate {
                return lhs.isICloudCandidate
            }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }

    let testSourceIds = store.calendars(for: .event)
        .filter { $0.title == testCalendarTitle }
        .compactMap { $0.source?.sourceIdentifier }

    return StatusPayload(
        supported: true,
        authorization: authorizationName(),
        sources: sources,
        testCalendarSourceIds: Array(Set(testSourceIds)).sorted()
    )
}

private func requireSource(_ id: String, in store: EKEventStore) throws -> EKSource {
    guard let source = store.sources.first(where: { $0.sourceIdentifier == id }) else {
        throw HelperError.missingSource(id)
    }
    return source
}

private func testCalendar(source: EKSource, store: EKEventStore) -> EKCalendar? {
    store.calendars(for: .event).first {
        $0.title == testCalendarTitle && $0.source?.sourceIdentifier == source.sourceIdentifier
    }
}

private func createSpike(sourceId: String, store: EKEventStore) throws -> MutationPayload {
    let source = try requireSource(sourceId, in: store)
    let calendar: EKCalendar
    if let existing = testCalendar(source: source, store: store) {
        calendar = existing
    } else {
        let created = EKCalendar(for: .event, eventStore: store)
        created.title = testCalendarTitle
        created.source = source
        created.color = NSColor(
            calibratedRed: 0.82,
            green: 0.23,
            blue: 0.31,
            alpha: 1
        )
        do {
            try store.saveCalendar(created, commit: true)
        } catch {
            throw HelperError.sourceCannotCreateCalendar(source.title)
        }
        calendar = created
    }

    let now = Date()
    let rangeStart = Calendar.current.date(byAdding: .year, value: -1, to: now)!
    let rangeEnd = Calendar.current.date(byAdding: .year, value: 2, to: now)!
    let predicate = store.predicateForEvents(
        withStart: rangeStart,
        end: rangeEnd,
        calendars: [calendar]
    )
    let existing = store.events(matching: predicate).first { $0.title == testEventTitle }
    let event = existing ?? EKEvent(eventStore: store)
    event.calendar = calendar
    event.title = testEventTitle
    event.notes = "Created by yCal to verify the EventKit → iCloud → Apple Calendar path. It is safe to remove from yCal Settings."
    event.url = URL(string: "ycal://apple-calendar-spike")

    if existing == nil {
        let rounded = Calendar.current.date(
            bySetting: .minute,
            value: 0,
            of: Calendar.current.date(byAdding: .hour, value: 1, to: now)!
        )!
        event.startDate = rounded
        event.endDate = Calendar.current.date(byAdding: .minute, value: 30, to: rounded)!
    }
    try store.save(event, span: .thisEvent, commit: true)

    return MutationPayload(
        status: statusPayload(store),
        calendarIdentifier: calendar.calendarIdentifier,
        eventIdentifier: event.eventIdentifier
    )
}

private func removeSpike(sourceId: String, store: EKEventStore) throws -> MutationPayload {
    let source = try requireSource(sourceId, in: store)
    if let calendar = testCalendar(source: source, store: store) {
        try store.removeCalendar(calendar, commit: true)
    }
    return MutationPayload(
        status: statusPayload(store),
        calendarIdentifier: nil,
        eventIdentifier: nil
    )
}

private func normalizedHex(_ raw: String) -> String? {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    guard value.range(of: "^#[0-9A-F]{6}$", options: .regularExpression) != nil else {
        return nil
    }
    return value
}

private func colorFromHex(_ hex: String) -> NSColor {
    let body = String(hex.dropFirst())
    let value = UInt64(body, radix: 16) ?? 0x616161
    return NSColor(
        calibratedRed: CGFloat((value >> 16) & 0xff) / 255,
        green: CGFloat((value >> 8) & 0xff) / 255,
        blue: CGFloat(value & 0xff) / 255,
        alpha: 1
    )
}

private func mirrorCalendarTitle(_ hex: String) -> String {
    "yCal · \(hex)"
}

private func isMirrorCalendar(_ calendar: EKCalendar, sourceId: String) -> Bool {
    guard calendar.source?.sourceIdentifier == sourceId else { return false }
    return calendar.title.range(
        of: "^yCal · #[0-9A-F]{6}$",
        options: .regularExpression
    ) != nil
}

private func markerURL(_ key: String) -> URL {
    URL(string: "ycal-mirror://event/\(key)")!
}

private func mirrorKey(_ event: EKEvent) -> String? {
    guard let url = event.url,
          url.scheme == "ycal-mirror",
          url.host == "event" else {
        return nil
    }
    let key = url.lastPathComponent
    return key.isEmpty ? nil : key
}

private func datesEqual(_ lhs: Date, _ rhs: Date) -> Bool {
    abs(lhs.timeIntervalSince(rhs)) < 0.5
}

private func eventNeedsUpdate(
    _ event: EKEvent,
    input: MirrorEventInput,
    calendar: EKCalendar
) -> Bool {
    let start = Date(timeIntervalSince1970: input.startMs / 1000)
    let end = Date(timeIntervalSince1970: input.endMs / 1000)
    return event.calendar.calendarIdentifier != calendar.calendarIdentifier
        || event.title != input.title
        || !datesEqual(event.startDate, start)
        || !datesEqual(event.endDate, end)
        || event.isAllDay != input.allDay
        || event.location != input.location
        || event.notes != input.notes
        || event.url != markerURL(input.key)
}

private func apply(
    _ input: MirrorEventInput,
    to event: EKEvent,
    calendar: EKCalendar
) {
    event.calendar = calendar
    event.title = input.title
    event.startDate = Date(timeIntervalSince1970: input.startMs / 1000)
    event.endDate = Date(timeIntervalSince1970: input.endMs / 1000)
    event.isAllDay = input.allDay
    event.location = input.location
    event.notes = input.notes
    event.url = markerURL(input.key)
}

private func isoString(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

private func syncMirror(
    sourceId: String,
    payloadPath: String,
    store: EKEventStore
) throws -> MirrorSyncResult {
    let source = try requireSource(sourceId, in: store)
    let data = try Data(contentsOf: URL(fileURLWithPath: payloadPath))
    let input: MirrorSyncInput
    do {
        input = try JSONDecoder().decode(MirrorSyncInput.self, from: data)
    } catch {
        throw HelperError.invalidMirrorPayload(error.localizedDescription)
    }

    let rangeStart = Date(timeIntervalSince1970: input.rangeStartMs / 1000)
    let rangeEnd = Date(timeIntervalSince1970: input.rangeEndMs / 1000)
    guard rangeEnd > rangeStart else {
        throw HelperError.invalidMirrorPayload("rangeEnd must be after rangeStart")
    }

    var desiredByKey: [String: MirrorEventInput] = [:]
    var desiredColors = Set<String>()
    for event in input.events {
        guard event.key.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            throw HelperError.invalidMirrorPayload("event key is not a SHA-256 hex digest")
        }
        guard let color = normalizedHex(event.color) else {
            throw HelperError.invalidMirrorPayload("event \(event.key) has an invalid color")
        }
        // EventKit rejects zero-duration entries. The TypeScript producer
        // already repairs them, but keep the native boundary defensive for
        // payloads produced by older or alternate yCal clients.
        let minimumDurationMs: Double = event.allDay ? 86_400_000 : 60_000
        let safeEndMs = event.endMs > event.startMs
            ? event.endMs
            : event.startMs + minimumDurationMs
        let normalized = MirrorEventInput(
            key: event.key,
            color: color,
            title: event.title,
            startMs: event.startMs,
            endMs: safeEndMs,
            allDay: event.allDay,
            location: event.location,
            notes: event.notes
        )
        desiredByKey[event.key] = normalized
        desiredColors.insert(color)
    }

    var calendarsCreated = 0
    var calendarsByColor: [String: EKCalendar] = [:]
    let allCalendars = store.calendars(for: .event)
    for color in desiredColors.sorted() {
        let title = mirrorCalendarTitle(color)
        if let existing = allCalendars.first(where: {
            $0.title == title && $0.source?.sourceIdentifier == sourceId
        }) {
            existing.color = colorFromHex(color)
            try store.saveCalendar(existing, commit: true)
            calendarsByColor[color] = existing
        } else {
            let calendar = EKCalendar(for: .event, eventStore: store)
            calendar.title = title
            calendar.source = source
            calendar.color = colorFromHex(color)
            do {
                try store.saveCalendar(calendar, commit: true)
            } catch {
                throw HelperError.sourceCannotCreateCalendar(source.title)
            }
            calendarsCreated += 1
            calendarsByColor[color] = calendar
        }
    }

    let managedCalendars = store.calendars(for: .event).filter {
        isMirrorCalendar($0, sourceId: sourceId)
    }
    var existingByKey: [String: [EKEvent]] = [:]
    if !managedCalendars.isEmpty {
        let predicate = store.predicateForEvents(
            withStart: rangeStart,
            end: rangeEnd,
            calendars: managedCalendars
        )
        for event in store.events(matching: predicate) {
            guard let key = mirrorKey(event) else { continue }
            existingByKey[key, default: []].append(event)
        }
    }

    var created = 0
    var updated = 0
    var moved = 0
    var deleted = 0

    for (key, desired) in desiredByKey {
        guard let targetCalendar = calendarsByColor[desired.color] else {
            throw HelperError.invalidMirrorPayload("missing calendar for \(desired.color)")
        }
        var matches = existingByKey.removeValue(forKey: key) ?? []
        let event: EKEvent
        if let first = matches.first {
            event = first
            matches.removeFirst()
            for duplicate in matches {
                try store.remove(duplicate, span: .thisEvent, commit: false)
                deleted += 1
            }
            let wasMoved = event.calendar.calendarIdentifier != targetCalendar.calendarIdentifier
            if eventNeedsUpdate(event, input: desired, calendar: targetCalendar) {
                apply(desired, to: event, calendar: targetCalendar)
                try store.save(event, span: .thisEvent, commit: false)
                updated += 1
                if wasMoved { moved += 1 }
            }
        } else {
            event = EKEvent(eventStore: store)
            apply(desired, to: event, calendar: targetCalendar)
            try store.save(event, span: .thisEvent, commit: false)
            created += 1
        }
    }

    // A complete Google refresh is required before the helper is called, so
    // every remaining yCal-owned marker in the managed time window is stale.
    // Unmarked user-created events are deliberately ignored.
    for staleEvents in existingByKey.values {
        for event in staleEvents {
            try store.remove(event, span: .thisEvent, commit: false)
            deleted += 1
        }
    }
    try store.commit()

    return MirrorSyncResult(
        status: statusPayload(store),
        rangeStart: isoString(rangeStart),
        rangeEnd: isoString(rangeEnd),
        sourceEventCount: desiredByKey.count,
        calendarsCreated: calendarsCreated,
        eventsCreated: created,
        eventsUpdated: updated,
        eventsMoved: moved,
        eventsDeleted: deleted
    )
}

private func writeJSON<T: Encodable>(_ payload: T, to handle: FileHandle) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(payload) else { return }
    handle.write(data)
    handle.write(Data("\n".utf8))
}

@main
private struct AppleCalendarSync {
    static func main() async {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            guard let command = args.first else { throw HelperError.usage }
            let store = EKEventStore()

            switch command {
            case "probe":
                writeJSON(statusPayload(store), to: .standardOutput)
            case "request-access":
                let granted = try await requestAccess(store)
                guard granted else { throw HelperError.accessDenied }
                store.reset()
                writeJSON(statusPayload(store), to: .standardOutput)
            case "create-spike":
                guard args.count == 2 else { throw HelperError.usage }
                if !hasFullAccess() {
                    let granted = try await requestAccess(store)
                    guard granted else { throw HelperError.accessDenied }
                    store.reset()
                }
                writeJSON(try createSpike(sourceId: args[1], store: store), to: .standardOutput)
            case "remove-spike":
                guard args.count == 2 else { throw HelperError.usage }
                guard hasFullAccess() else { throw HelperError.accessDenied }
                writeJSON(try removeSpike(sourceId: args[1], store: store), to: .standardOutput)
            case "sync-mirror":
                guard args.count == 3 else { throw HelperError.usage }
                guard hasFullAccess() else { throw HelperError.accessDenied }
                writeJSON(
                    try syncMirror(sourceId: args[1], payloadPath: args[2], store: store),
                    to: .standardOutput
                )
            default:
                throw HelperError.usage
            }
        } catch {
            writeJSON(
                ErrorPayload(error: error.localizedDescription),
                to: .standardError
            )
            Foundation.exit(1)
        }
    }
}
