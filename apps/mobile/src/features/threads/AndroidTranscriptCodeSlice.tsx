import { memo } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";

import type { NativeMarkdownTextStyle } from "@t3tools/mobile-markdown-text/types";

import { CopyTextButton } from "../../components/CopyTextButton";
import type { AndroidTranscriptCodePart } from "./androidTranscriptSlices";

const MONO_FONT_FAMILY = Platform.select({
  ios: "ui-monospace",
  android: "monospace",
  default: "monospace",
});

/**
 * Code inside a transcript slice scales with the body size, matching the
 * highlighted fence (12pt at the default 15pt body).
 */
function codeSliceFontSize(textStyle: NativeMarkdownTextStyle): number {
  return Math.max(10, Math.round(textStyle.fontSize * 0.8));
}

/**
 * Line height for a plain code window. Kept identical to the highlighted fence
 * so a windowed block does not jump when the reader stops on it.
 */
function codeSliceLineHeight(textStyle: NativeMarkdownTextStyle): number {
  return codeSliceFontSize(textStyle) + 6;
}

/**
 * Corner radii for one window of a fence. Middle and trailing windows stay
 * square on the joined edge so the windows read as a single card.
 */
function codeSliceRadius(part: AndroidTranscriptCodePart): {
  readonly borderTopLeftRadius: number;
  readonly borderTopRightRadius: number;
  readonly borderBottomLeftRadius: number;
  readonly borderBottomRightRadius: number;
} {
  const radius = part === "start" || part === "end" ? 10 : 0;
  return {
    borderTopLeftRadius: part === "start" ? radius : 0,
    borderTopRightRadius: part === "start" ? radius : 0,
    borderBottomLeftRadius: part === "end" ? radius : 0,
    borderBottomRightRadius: part === "end" ? radius : 0,
  };
}

/**
 * One plain-text window of a long fenced block.
 *
 * Highlighted fences mount a `Text` per Shiki token. On Android that tree is
 * created on the UI thread in the frame the row enters, which is the settled-
 * thread hitch. A window is a single non-selectable `Text`; the header copies
 * the whole fence, not just the lines in view.
 */
export const AndroidTranscriptCodeSlice = memo(function AndroidTranscriptCodeSlice(props: {
  readonly text: string;
  readonly language: string | null;
  readonly part: Exclude<AndroidTranscriptCodePart, "only">;
  readonly fullCode: string;
  readonly textStyle: NativeMarkdownTextStyle;
}) {
  const fontSize = codeSliceFontSize(props.textStyle);
  const lineHeight = codeSliceLineHeight(props.textStyle);
  const showHeader = props.part === "start";
  const languageLabel = props.language?.toUpperCase() ?? "CODE";
  return (
    <View
      style={[
        styles.card,
        codeSliceRadius(props.part),
        {
          backgroundColor: props.textStyle.codeBlockBackgroundColor,
          borderColor: props.textStyle.dividerColor,
          borderTopWidth: showHeader ? 1 : 0,
        },
      ]}
    >
      {showHeader ? (
        <View
          style={[
            styles.header,
            {
              borderBottomColor: props.textStyle.dividerColor,
            },
          ]}
        >
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              color: props.textStyle.mutedColor,
              fontFamily: MONO_FONT_FAMILY,
              fontSize,
              ...(Platform.OS === "android" ? { includeFontPadding: false } : null),
            }}
          >
            {languageLabel}
          </Text>
          <CopyTextButton
            accessibilityLabel={`Copy ${languageLabel.toLowerCase()} code`}
            text={props.fullCode}
            tintColor={props.textStyle.mutedColor}
            copiedTintColor={props.textStyle.linkColor}
            backgroundColor={props.textStyle.codeBackgroundColor}
            borderColor={props.textStyle.dividerColor}
            buttonSize={34}
            iconSize={14}
          />
        </View>
      ) : null}
      <ScrollView
        horizontal
        bounces={false}
        nestedScrollEnabled={Platform.OS === "android"}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.body}
      >
        <Text
          selectable={false}
          style={{
            color: props.textStyle.codeColor,
            fontFamily: MONO_FONT_FAMILY,
            fontSize,
            lineHeight,
            ...(Platform.OS === "android"
              ? { includeFontPadding: false, textBreakStrategy: "simple" as const }
              : null),
          }}
        >
          {props.text}
        </Text>
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    borderCurve: "continuous",
    borderWidth: 1,
    overflow: "hidden",
  },
  header: {
    minHeight: 42,
    borderBottomWidth: 1,
    paddingLeft: 14,
    paddingRight: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  body: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
});
