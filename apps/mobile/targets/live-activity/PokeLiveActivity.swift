import ActivityKit
import SwiftUI
import WidgetKit

/// Keep in step with PokeTaskAttributes in modules/poke-live-activity: ActivityKit matches the
/// two by name and decodes the same fields.
struct PokeTaskAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var title: String
    var line: String
    /// "working", "waiting", "done" or "failed".
    var state: String
    var startedAt: Date
  }

  var taskId: String
}

@main
struct PokeWidgets: WidgetBundle {
  var body: some Widget {
    PokeTaskLiveActivity()
  }
}

struct PokeTaskLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: PokeTaskAttributes.self) { context in
      LockScreen(state: context.state)
        .widgetURL(URL(string: "poke://agent"))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Mark(size: 28)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(context.state.title).font(.headline).lineLimit(1)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Clock(state: context.state).font(.headline)
        }
        DynamicIslandExpandedRegion(.bottom) {
          Text(context.state.line)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
      } compactLeading: {
        Mark(size: 18)
      } compactTrailing: {
        Clock(state: context.state).frame(maxWidth: 48)
      } minimal: {
        Mark(size: 18)
      }
      .widgetURL(URL(string: "poke://agent"))
    }
  }
}

/// "Planning Lisbon · Working 0:41" over the current step line.
struct LockScreen: View {
  let state: PokeTaskAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Mark(size: 22)
        Text(state.title).font(.headline).lineLimit(1)
        Spacer(minLength: 8)
        if state.state == "working" {
          Text("Working").foregroundStyle(.secondary)
        }
        Clock(state: state)
      }
      .font(.subheadline)
      Text(state.line)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .lineLimit(2)
    }
    .padding(16)
  }
}

/// A timer counting up while the task works; how it stands otherwise.
struct Clock: View {
  let state: PokeTaskAttributes.ContentState

  var body: some View {
    switch state.state {
    case "working":
      Text(state.startedAt, style: .timer).monospacedDigit().multilineTextAlignment(.trailing)
    case "waiting":
      Text("Needs you")
    case "done":
      Text("Done")
    default:
      Text("Stopped")
    }
  }
}

struct Mark: View {
  let size: CGFloat

  var body: some View {
    Image("PokeMark")
      .resizable()
      .scaledToFill()
      .frame(width: size, height: size)
      .clipShape(Circle())
  }
}
