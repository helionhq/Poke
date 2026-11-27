import type { VaultEntry } from "@poke/client";
import { Button, Chip, Icon, IconButton, ListGroup, ListRow, Text, useColors } from "@poke/ui-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, KeyboardAvoidingView, Modal, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePoke } from "../src/lib/poke";
import { vaultProof, VaultLocked } from "../src/lib/vaultKey";
import { Field } from "../src/ui/Field";
import { Footnote, Screen } from "../src/ui/Screen";

type Kind = VaultEntry["kind"];

/** What each kind of entry asks for: plain fields (shown) and secrets (never shown unasked). */
const FORMS: Record<Kind, { label: string; fields: [string, string][]; secrets: [string, string][] }> = {
  login: {
    label: "Login",
    fields: [
      ["username", "Email or username"],
      ["url", "Website"],
    ],
    secrets: [["password", "Password"]],
  },
  api_key: { label: "API key", fields: [], secrets: [["key", "Key"]] },
  card: {
    label: "Card",
    fields: [["name", "Name on card"]],
    secrets: [
      ["number", "Card number"],
      ["expiry", "Expiry (MM/YY)"],
      ["cvc", "Security code"],
    ],
  },
  code: { label: "Code", fields: [], secrets: [["code", "Code"]] },
  note: { label: "Note", fields: [], secrets: [["note", "Note"]] },
};

const usedBy = (e: VaultEntry) =>
  e.usedBy.length
    ? `Used by ${e.usedBy.join(", ")}`
    : (e.description ?? e.fields.username ?? FORMS[e.kind].label);
const slug = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);

/**
 * 15 Vault: behind Face ID. Names and plain fields only; revealing, editing and deleting each
 * ask for Face ID again. Nothing here is cached on the phone, and it locks when the app leaves.
 */
export default function VaultScreen() {
  const { client } = usePoke();
  const [entries, setEntries] = useState<VaultEntry[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<VaultEntry>();
  const [adding, setAdding] = useState(false);

  const unlock = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await client.vault(await vaultProof(client, "list"));
      setEntries(res.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open the vault");
    } finally {
      setBusy(false);
    }
  }, [client]);

  useEffect(() => {
    void unlock();
    // Lock again whenever the app leaves the foreground.
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        setEntries(undefined);
        setOpen(undefined);
        setAdding(false);
      }
    });
    return () => sub.remove();
  }, [unlock]);

  const logins = entries?.filter((e) => e.kind === "login") ?? [];
  const cards = entries?.filter((e) => e.kind === "card" || e.kind === "code") ?? [];
  const keys = entries?.filter((e) => e.kind === "api_key" || e.kind === "note") ?? [];
  const row = (e: VaultEntry) => (
    <ListRow
      key={e.name}
      tile={e.kind === "login" ? "blue" : e.kind === "card" ? "green" : e.kind === "code" ? "orange" : "ink"}
      title={e.name}
      subtitle={usedBy(e)}
      value="••••••"
      icon={(color) => (
        <Icon
          name={e.kind === "login" ? "key" : e.kind === "api_key" ? "terminal" : "lock"}
          size={16}
          color={color}
        />
      )}
      onPress={() => setOpen(e)}
    />
  );

  return (
    <Screen
      title="Vault"
      subtitle="Logins, keys and cards Poke can use without ever seeing them."
      trailing={
        entries ? (
          <IconButton
            accessibilityLabel="Add to the vault"
            onPress={() => setAdding(true)}
            icon={(color) => <Icon name="plus" size={20} color={color} strokeWidth={2.4} />}
          />
        ) : undefined
      }
      loading={busy && !entries}
    >
      {entries ? (
        <View style={{ paddingHorizontal: 20, flexDirection: "row", marginTop: -8 }}>
          <Chip state="outline" label="Unlocked with Face ID" icon={<Icon name="faceId" size={14} />} />
        </View>
      ) : (
        <View style={{ paddingHorizontal: 16, gap: 12 }}>
          {error ? (
            <Text size="subhead" color="ink2" align="center">
              {error}
            </Text>
          ) : null}
          <Button
            tone="ink"
            width="fill"
            label="Unlock with Face ID"
            icon={<Icon name="faceId" size={18} />}
            onPress={() => void unlock()}
            disabled={busy}
          />
        </View>
      )}
      {logins.length ? <ListGroup header="Logins">{logins.map(row)}</ListGroup> : null}
      {cards.length ? <ListGroup header="Cards and codes">{cards.map(row)}</ListGroup> : null}
      {keys.length ? <ListGroup header="Keys and notes">{keys.map(row)}</ListGroup> : null}
      {entries && entries.length === 0 ? (
        <Text size="subhead" color="ink2" align="center" style={{ paddingHorizontal: 32 }}>
          Nothing saved yet. When Poke needs a password, he asks in the thread and it lands here.
        </Text>
      ) : null}
      {entries ? (
        <Footnote>
          Poke fills these in for you. They never show up in the thread, and Poke asks before it pays for
          anything.
        </Footnote>
      ) : null}
      {open ? (
        <EntrySheet
          entry={open}
          onClose={() => setOpen(undefined)}
          onChanged={(next) => {
            setEntries((old) =>
              next
                ? old?.map((e) => (e.name === next.name ? next : e))
                : old?.filter((e) => e.name !== open.name),
            );
            setOpen(next);
          }}
        />
      ) : null}
      {adding ? (
        <AddSheet
          onClose={() => setAdding(false)}
          onAdded={(entry) => {
            setEntries((old) => [...(old ?? []).filter((e) => e.name !== entry.name), entry]);
            setAdding(false);
          }}
        />
      ) : null}
    </Screen>
  );
}

function Sheet({
  title,
  onClose,
  children,
  action,
}: {
  title: string;
  onClose(): void;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.groundGrouped }}>
        <View
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 }}
        >
          <IconButton
            accessibilityLabel="Close"
            onPress={onClose}
            icon={(color) => <Icon name="close" size={18} color={color} strokeWidth={2.4} />}
          />
          <Text size="callout" weight="semibold" numberOfLines={1} style={{ flex: 1, textAlign: "center" }}>
            {title}
          </Text>
          <View style={{ width: 44 }} />
        </View>
        <ScrollView
          contentContainerStyle={{ gap: 20, paddingBottom: insets.bottom + 24 }}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
        {action ? <View style={{ padding: 16, paddingBottom: insets.bottom + 12 }}>{action}</View> : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** One entry: plain fields, masked secrets; reveal for 30 seconds after Face ID. */
function EntrySheet({
  entry,
  onClose,
  onChanged,
}: {
  entry: VaultEntry;
  onClose(): void;
  onChanged(next?: VaultEntry): void;
}) {
  const { client } = usePoke();
  const [revealed, setRevealed] = useState<Record<string, string>>();
  const [editing, setEditing] = useState<Record<string, string>>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);
  const fail = (e: unknown) => {
    if (e instanceof VaultLocked && e.reason === "cancelled") return;
    Alert.alert("Couldn't do that", e instanceof Error ? e.message : "");
  };

  const reveal = async () => {
    try {
      const res = await client.revealVaultEntry(entry.name, await vaultProof(client, "reveal", entry.name));
      setRevealed(res.secrets);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setRevealed(undefined), 30_000);
    } catch (e) {
      fail(e);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const secrets = Object.fromEntries(Object.entries(editing).filter(([, v]) => v.length > 0));
    try {
      const res = await client.editVaultEntry(
        entry.name,
        { secrets },
        await vaultProof(client, "edit", entry.name),
      );
      setEditing(undefined);
      setRevealed(undefined);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onChanged(res.entry);
    } catch (e) {
      fail(e);
    }
  };

  const remove = () =>
    Alert.alert(`Delete ${entry.name}?`, "Poke won't be able to use it anymore.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await client.deleteVaultEntry(entry.name, await vaultProof(client, "delete", entry.name));
            onChanged(undefined);
          } catch (e) {
            fail(e);
          }
        },
      },
    ]);

  const copy = (value: string) => {
    void Clipboard.setStringAsync(value);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <Sheet
      title={entry.name}
      onClose={onClose}
      {...(editing
        ? {
            action: (
              <Button tone="ink" width="fill" label="Save with Face ID" onPress={() => void saveEdit()} />
            ),
          }
        : {})}
    >
      {Object.keys(entry.fields).length ? (
        <ListGroup>
          {Object.entries(entry.fields).map(([k, v]) => (
            <ListRow key={k} tile="none" title={k} value={v} accessory="none" onPress={() => copy(v)} />
          ))}
        </ListGroup>
      ) : null}
      {editing ? (
        entry.secretFields.map((k) => (
          <Field
            key={k}
            label={`New ${k}`}
            value={editing[k] ?? ""}
            onChangeText={(v) => setEditing((old) => ({ ...old, [k]: v }))}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            hint="Leave empty to keep it."
          />
        ))
      ) : (
        <ListGroup footer={revealed ? "Hides again in 30 seconds." : undefined}>
          {entry.secretFields.map((k) => (
            <ListRow
              key={k}
              tile="none"
              title={k}
              value={revealed?.[k] ?? "••••••••"}
              accessory="none"
              {...(revealed?.[k] ? { onPress: () => copy(revealed[k]!) } : {})}
            />
          ))}
        </ListGroup>
      )}
      <ListGroup footer={usedBy(entry)}>
        {!editing ? (
          <ListRow
            tile="none"
            title={revealed ? "Hide" : "Reveal with Face ID"}
            accessory="none"
            onPress={() => (revealed ? setRevealed(undefined) : void reveal())}
          />
        ) : null}
        <ListRow
          tile="none"
          title={editing ? "Cancel editing" : "Change"}
          accessory="none"
          onPress={() => setEditing(editing ? undefined : {})}
        />
        <ListRow tile="none" title="Delete" accessory="none" destructive onPress={remove} />
      </ListGroup>
    </Sheet>
  );
}

/** "+": add an entry by hand. Secrets stay in this sheet's state until saved, then it's gone. */
function AddSheet({ onClose, onAdded }: { onClose(): void; onAdded(entry: VaultEntry): void }) {
  const { client } = usePoke();
  const [kind, setKind] = useState<Kind>("login");
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const form = FORMS[kind];
  const entryName = slug(name);
  const ready = entryName.length > 0 && form.secrets.every(([k]) => (values[k] ?? "").length > 0);

  const save = async () => {
    setSaving(true);
    try {
      const fields = Object.fromEntries(
        form.fields.flatMap(([k]) => (values[k]?.trim() ? [[k, values[k]!.trim()]] : [])),
      );
      const secrets = Object.fromEntries(form.secrets.map(([k]) => [k, values[k] ?? ""]));
      const res = await client.addVaultEntry(
        { name: entryName, kind, fields, secrets },
        await vaultProof(client, "add", entryName),
      );
      setValues({});
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onAdded(res.entry);
    } catch (e) {
      if (!(e instanceof VaultLocked && e.reason === "cancelled"))
        Alert.alert("Couldn't save it", e instanceof Error ? e.message : "");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      title="Add to the vault"
      onClose={onClose}
      action={
        <Button
          tone="ink"
          width="fill"
          label={saving ? "Saving…" : "Save with Face ID"}
          disabled={!ready || saving}
          onPress={() => void save()}
        />
      }
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
      >
        {(Object.keys(FORMS) as Kind[]).map((k) => (
          <Chip
            key={k}
            label={FORMS[k].label}
            state={k === kind ? "selected" : "default"}
            onPress={() => setKind(k)}
          />
        ))}
      </ScrollView>
      <Field
        label="Name"
        value={name}
        onChangeText={setName}
        placeholder={kind === "login" ? "resy.login" : kind === "api_key" ? "openai.key" : "visa"}
        autoCapitalize="none"
        autoCorrect={false}
        hint={entryName && entryName !== name ? `Saved as ${entryName}` : "How Poke refers to it."}
      />
      {form.fields.map(([k, label]) => (
        <Field
          key={k}
          label={label}
          value={values[k] ?? ""}
          onChangeText={(v) => setValues((o) => ({ ...o, [k]: v }))}
          autoCapitalize="none"
          autoCorrect={false}
        />
      ))}
      {form.secrets.map(([k, label]) => (
        <Field
          key={k}
          label={label}
          value={values[k] ?? ""}
          onChangeText={(v) => setValues((o) => ({ ...o, [k]: v }))}
          secureTextEntry={kind !== "note"}
          multiline={kind === "note"}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          keyboardType={kind === "card" ? "numbers-and-punctuation" : "default"}
        />
      ))}
    </Sheet>
  );
}
