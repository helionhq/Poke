import ActivityKit
import ExpoModulesCore

/// Keep in step with PokeTaskAttributes in targets/live-activity: ActivityKit matches the two by
/// name and decodes the same fields.
struct PokeTaskAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var title: String
    var line: String
    var state: String
    var startedAt: Date
  }

  var taskId: String
}

struct ActivityProps: Record {
  @Field var title: String = ""
  @Field var line: String = ""
  @Field var state: String = "working"
  /// ms since epoch
  @Field var startedAt: Double = 0

  var content: PokeTaskAttributes.ContentState {
    PokeTaskAttributes.ContentState(
      title: title,
      line: line,
      state: state,
      startedAt: Date(timeIntervalSince1970: startedAt / 1000)
    )
  }
}

internal final class ActivitiesOffException: Exception, @unchecked Sendable {
  override var reason: String {
    "Live Activities are turned off for Poke"
  }
}

/// Local ActivityKit updates only (no APNs on a free Apple ID, brief section 3). The app starts an
/// activity while it's in the foreground and updates it while it runs.
public class PokeLiveActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PokeLiveActivity")

    Function("isEnabled") { () -> Bool in
      ActivityAuthorizationInfo().areActivitiesEnabled
    }

    /// Activities still on screen, so the app can pick them up again after a relaunch.
    Function("running") { () -> [[String: String]] in
      Activity<PokeTaskAttributes>.activities.map { ["id": $0.id, "taskId": $0.attributes.taskId] }
    }

    AsyncFunction("start") { (taskId: String, props: ActivityProps) throws -> String in
      guard ActivityAuthorizationInfo().areActivitiesEnabled else { throw ActivitiesOffException() }
      let activity = try Activity.request(
        attributes: PokeTaskAttributes(taskId: taskId),
        content: ActivityContent(state: props.content, staleDate: nil),
        pushType: nil
      )
      return activity.id
    }

    AsyncFunction("update") { (id: String, props: ActivityProps) async in
      guard let activity = Activity<PokeTaskAttributes>.activities.first(where: { $0.id == id }) else { return }
      await activity.update(ActivityContent(state: props.content, staleDate: nil))
    }

    /// Ends with a final state, left on the Lock Screen for `dismissAfter` seconds.
    AsyncFunction("end") { (id: String, props: ActivityProps, dismissAfter: Double) async in
      guard let activity = Activity<PokeTaskAttributes>.activities.first(where: { $0.id == id }) else { return }
      let policy: ActivityUIDismissalPolicy =
        dismissAfter <= 0 ? .immediate : .after(Date().addingTimeInterval(dismissAfter))
      await activity.end(ActivityContent(state: props.content, staleDate: nil), dismissalPolicy: policy)
    }
  }
}
