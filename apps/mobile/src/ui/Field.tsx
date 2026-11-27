import { Text, useColors } from "@poke/ui-native";
import { TextInput, View, type TextInputProps } from "react-native";

/** A labelled text field on a card, for the management screens' small forms. */
export function Field({
  label,
  hint,
  multiline,
  ...props
}: TextInputProps & { label: string; hint?: string }) {
  const c = useColors();
  return (
    <View style={{ paddingHorizontal: 16, gap: 6 }}>
      <Text size="footnote" weight="medium" color="ink2" style={{ paddingHorizontal: 4 }}>
        {label}
      </Text>
      <TextInput
        placeholderTextColor={c.ink3}
        accessibilityLabel={label}
        multiline={multiline}
        {...props}
        style={{
          minHeight: multiline ? 120 : 48,
          paddingHorizontal: 16,
          paddingTop: multiline ? 14 : 0,
          paddingBottom: multiline ? 14 : 0,
          borderRadius: 16,
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: c.separator,
          color: c.ink,
          fontFamily: "OpenRunde-Regular",
          fontSize: 16,
          lineHeight: multiline ? 22 : undefined,
          textAlignVertical: multiline ? "top" : "center",
        }}
      />
      {hint ? (
        <Text size="footnote" color="ink3" style={{ paddingHorizontal: 4 }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
