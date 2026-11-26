import { ListGroup, ListRow, SearchResult, ThemeProvider, highlight } from "@poke/ui-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { serverId, snippet } from "../lib/text";

describe("ListRow", () => {
  it("toggles from the row when it only has a switch", async () => {
    const onToggle = jest.fn();
    await render(
      <ThemeProvider scheme="light">
        <ListGroup>
          <ListRow title="Morning brief" accessory="toggle-off" onToggle={onToggle} />
        </ListGroup>
      </ThemeProvider>,
    );
    await fireEvent.press(screen.getByRole("switch"));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("opens from the row and toggles only from the switch when it has both", async () => {
    const onToggle = jest.fn();
    const onPress = jest.fn();
    await render(
      <ThemeProvider scheme="light">
        <ListRow
          title="Morning brief"
          subtitle="Every day at 7:30 AM"
          accessory="toggle-on"
          onToggle={onToggle}
          onPress={onPress}
        />
      </ThemeProvider>,
    );
    await fireEvent.press(screen.getByRole("button"));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("switch"));
    expect(onToggle).toHaveBeenCalledWith(false);
  });
});

describe("search", () => {
  it("highlights the server's «marked» spans", async () => {
    expect(highlight("Booked «Marlow» Room")).toEqual([
      { text: "Booked ", hit: false },
      { text: "Marlow", hit: true },
      { text: " Room", hit: false },
    ]);
    await render(
      <ThemeProvider scheme="light">
        <SearchResult who="Poke" when="9:14 AM" snippet="Booked «Marlow» Room" />
      </ThemeProvider>,
    );
    expect(screen.getByText("Marlow")).toBeTruthy();
  });

  it("trims long hits to a window around the first match", async () => {
    const long = `${"a ".repeat(100)}«Marlow» ${"b ".repeat(100)}`;
    const out = snippet(long);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toContain("«Marlow»");
    expect(snippet("short «hit»")).toBe("short «hit»");
  });
});

describe("serverId", () => {
  it("names MCP servers after their host", async () => {
    expect(serverId("https://mcp.linear.app/sse")).toBe("mcp-linear-app");
    expect(serverId("https://www.Example.com:8443/mcp")).toBe("example-com");
    expect(serverId("not a url")).toBe("not-a-url");
  });
});
