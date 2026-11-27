import type { ApprovalRule } from "@poke/client";
import { ListGroup, ListRow, Logo } from "@poke/ui-native";
import { Alert } from "react-native";
import { usePoke, useRemote } from "../src/lib/poke";
import { Empty, Footnote, Screen } from "../src/ui/Screen";

/** "Always allow" rules from tool approvals: what Poke may do without asking again. */
export default function ApprovalsScreen() {
  const { client } = usePoke();
  const list = useRemote((p) => p.client.approvalRules(), []);
  const rules = list.data?.rules ?? [];

  const remove = (rule: ApprovalRule) =>
    Alert.alert("Stop allowing this?", `Poke will ask again before: ${rule.description}`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Stop allowing",
        style: "destructive",
        onPress: async () => {
          try {
            await client.deleteApprovalRule(rule.id);
            list.setData((old) => old && { rules: old.rules.filter((r) => r.id !== rule.id) });
          } catch (e) {
            Alert.alert("Couldn't change that", e instanceof Error ? e.message : "");
          }
        },
      },
    ]);

  return (
    <Screen
      title="Always allowed"
      subtitle="When an app asks first, you can let Poke go ahead from then on."
      loading={list.loading && !list.data}
      {...(list.error ? { error: list.error } : {})}
      onRefresh={() => void list.reload()}
    >
      {rules.length === 0 && list.data ? (
        <Empty
          title="Nothing yet"
          body="Tap “Always allow” on an approval in the thread and it shows up here."
        />
      ) : null}
      {rules.length > 0 ? (
        <ListGroup>
          {rules.map((r) => (
            <ListRow
              key={r.id}
              tile="logo"
              title={r.description}
              subtitle={`${r.integration} · since ${new Date(r.createdAt).toLocaleDateString()}`}
              icon={<Logo mark={{ app: r.integration, name: r.integration }} size={20} radius={5} />}
              accessory="none"
              onPress={() => remove(r)}
            />
          ))}
        </ListGroup>
      ) : null}
      <Footnote>
        Tap a rule to stop allowing it. Everything else Poke does on his own; only actions an app marks as
        risky ever ask.
      </Footnote>
    </Screen>
  );
}
