import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconAdjustmentsFilled,
  IconArrowsShuffle,
  IconCheck,
  IconChevronDown,
  IconCircleFilled,
  IconDeviceSpeakerFilled,
  IconHeadphonesFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipBackFilled,
  IconTransitionRightFilled,
} from "@tabler/icons-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { SegmentedControl } from "@/components/ui/segmented";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import {
  eqGains,
  usePlaybackSettings,
  EQ_BANDS,
  EQ_RANGE,
  type BackButtonMode,
  type EqPreset,
} from "@/lib/store/playback-settings";
import { canSelectOutputDevice } from "@/lib/audio-graph";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Sound and playback behaviour, per the design handoff. Every control
 * writes to `usePlaybackSettings`; the audio engine reads from it (see
 * `src/lib/audio-engine.ts`). The output device row only appears where
 * the webview can actually switch sinks.
 */
export function PlaybackTab() {
  return (
    <TabPane>
      <Group>
        <CrossfadeRow />
        <NormalizeRow />
      </Group>
      <EqualizerGroup />
      <Group>
        <MonoRow />
        {canSelectOutputDevice() ? <OutputDeviceRow /> : null}
      </Group>
      <BackButtonGroup />
      <Group>
        <ResumeRow />
        <RadioVarietyRow />
      </Group>
    </TabPane>
  );
}

/* ------------------------------------------------------------------ */
/* Crossfade                                                           */
/* ------------------------------------------------------------------ */

function CrossfadeRow() {
  const t = useT();
  const seconds = usePlaybackSettings((s) => s.crossfadeSec);
  const setSeconds = usePlaybackSettings((s) => s.setCrossfadeSec);
  const bassSwap = usePlaybackSettings((s) => s.mixBassSwap);
  const setBassSwap = usePlaybackSettings((s) => s.setMixBassSwap);
  const smartTiming = usePlaybackSettings((s) => s.mixSmartTiming);
  const setSmartTiming = usePlaybackSettings((s) => s.setMixSmartTiming);

  return (
    <>
      <SettingRow
        icon={IconTransitionRightFilled}
        settingId="crossfade"
        title={t("settings.playback.crossfade")}
        description={t("settings.playback.crossfadeDesc")}
        control={
          <div className="flex items-center gap-3.5">
            <Slider
              value={[seconds]}
              onValueChange={([v]) => setSeconds(v)}
              min={0}
              max={30}
              step={1}
              aria-label={t("settings.playback.crossfadeSeconds")}
              className="w-[150px]"
            />
            <Stepper value={seconds} onChange={setSeconds} min={0} max={30} />
          </div>
        }
      />
      <SettingRow
        icon={IconTransitionRightFilled}
        settingId="dj-bass-swap"
        title={t("settings.playback.djBassSwap")}
        description={t("settings.playback.djBassSwapDesc")}
        control={
          <Switch
            checked={bassSwap}
            onCheckedChange={setBassSwap}
            disabled={seconds === 0}
            aria-label={t("settings.playback.djBassSwap")}
          />
        }
      />
      <SettingRow
        icon={IconTransitionRightFilled}
        settingId="smart-mix-timing"
        title={t("settings.playback.smartMixTiming")}
        description={t("settings.playback.smartMixTimingDesc")}
        control={
          <Switch
            checked={smartTiming}
            onCheckedChange={setSmartTiming}
            disabled={seconds === 0}
            aria-label={t("settings.playback.smartMixTiming")}
          />
        }
      />
    </>
  );
}

/** Number box with its own increment pair, as in the design. */
function Stepper({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  const t = useT();
  const step = (delta: number) =>
    onChange(Math.min(max, Math.max(min, value + delta)));

  return (
    <div className="flex items-center gap-0 rounded-lg border border-w090 bg-w040 py-0.5 pl-2 pr-0.5">
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        aria-label={t("settings.playback.crossfadeSeconds")}
        // Chromium's own spinners would sit next to ours.
        className="w-6 bg-transparent text-right text-[13px] font-semibold tabular-nums text-t2 outline-hidden [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="pl-1 pr-1.5 text-[12px] text-t6">s</span>
      <div className="flex flex-col gap-px">
        <StepButton
          label={t("settings.playback.increase")}
          onClick={() => step(1)}
          up
        />
        <StepButton
          label={t("settings.playback.decrease")}
          onClick={() => step(-1)}
        />
      </div>
    </div>
  );
}

function StepButton({
  label,
  onClick,
  up = false,
}: {
  label: string;
  onClick: () => void;
  up?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid h-[11px] w-4 cursor-pointer place-items-center rounded-[3px] text-t6 transition-colors duration-[140ms] hover:bg-w090 hover:text-t2"
    >
      <IconChevronDown
        className={cn("size-[9px]", up && "rotate-180")}
        stroke={2.6}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Loudness, mono                                                      */
/* ------------------------------------------------------------------ */

function NormalizeRow() {
  const t = useT();
  const on = usePlaybackSettings((s) => s.normalizeVolume);
  const set = usePlaybackSettings((s) => s.setNormalizeVolume);
  return (
    <SettingRow
      icon={IconDeviceSpeakerFilled}
      settingId="volume-normalization"
      title={t("settings.playback.volumeNormalization")}
      description={t("settings.playback.volumeNormalizationDesc")}
      control={<Switch checked={on} onCheckedChange={set} />}
    />
  );
}

function MonoRow() {
  const t = useT();
  const on = usePlaybackSettings((s) => s.monoAudio);
  const set = usePlaybackSettings((s) => s.setMonoAudio);
  return (
    <SettingRow
      icon={IconCircleFilled}
      settingId="mono-audio"
      title={t("settings.playback.monoAudio")}
      description={t("settings.playback.monoAudioDesc")}
      control={<Switch checked={on} onCheckedChange={set} />}
    />
  );
}

function RadioVarietyRow() {
  const t = useT();
  const on = usePlaybackSettings((s) => s.radioVariety);
  const set = usePlaybackSettings((s) => s.setRadioVariety);
  return (
    <SettingRow
      icon={IconArrowsShuffle}
      settingId="varied-radio"
      title={t("settings.playback.variedRadio")}
      description={t("settings.playback.variedRadioDesc")}
      control={
        <Switch
          checked={on}
          onCheckedChange={set}
          aria-label={t("settings.playback.variedRadio")}
        />
      }
    />
  );
}

function ResumeRow() {
  const t = useT();
  const on = usePlaybackSettings((s) => s.resumePlayback);
  const set = usePlaybackSettings((s) => s.setResumePlayback);
  return (
    <SettingRow
      icon={IconPlayerPlayFilled}
      settingId="resume-where-you-left-off"
      title={t("settings.playback.resumeWhereYouLeftOff")}
      description={t("settings.playback.resumeWhereYouLeftOffDesc")}
      control={<Switch checked={on} onCheckedChange={set} />}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Equalizer                                                           */
/* ------------------------------------------------------------------ */

const PRESET_LABEL_KEYS: Record<EqPreset, string> = {
  flat: "settings.playback.eqFlat",
  bass: "settings.playback.eqBass",
  vocal: "settings.playback.eqVocal",
  treble: "settings.playback.eqTreble",
  late: "settings.playback.eqLate",
  custom: "settings.playback.eqCustom",
};

function EqualizerGroup() {
  const t = useT();
  const enabled = usePlaybackSettings((s) => s.eqEnabled);
  const setEnabled = usePlaybackSettings((s) => s.setEqEnabled);
  const preset = usePlaybackSettings((s) => s.eqPreset);
  const setPreset = usePlaybackSettings((s) => s.setEqPreset);

  return (
    <Group>
      <div className="flex flex-col">
        <SettingRow
          icon={IconAdjustmentsFilled}
          settingId="equalizer"
          title={t("settings.playback.equalizer")}
          description={t("settings.playback.equalizerDesc")}
          control={<Switch checked={enabled} onCheckedChange={setEnabled} />}
        />
        {enabled ? (
          <div className="flex flex-col gap-3.5 pb-4 pt-0.5">
            <div className="flex flex-wrap gap-[7px]">
              {Object.entries(PRESET_LABEL_KEYS).map(([value, key]) => {
                const on = preset === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setPreset(value as EqPreset)}
                    className={cn(
                      "cursor-pointer rounded-lg border px-3 py-1.5 text-[12.5px] transition-colors duration-[140ms]",
                      on
                        ? "border-transparent bg-brand-secondary/25 font-semibold text-brand-secondary-soft"
                        : "border-w070 bg-w040 font-medium text-t5 hover:bg-w070 hover:text-t3",
                    )}
                  >
                    {t(key)}
                  </button>
                );
              })}
            </div>
            <EqBands />
          </div>
        ) : null}
      </div>
    </Group>
  );
}

/** Height of a band's travel, and the geometry the design draws it on. */
const TRACK_H = 88;
const KNOB = 14;

function EqBands() {
  const preset = usePlaybackSettings((s) => s.eqPreset);
  const custom = usePlaybackSettings((s) => s.eqCustomGains);
  const gains = eqGains({ eqPreset: preset, eqCustomGains: custom });

  return (
    <div className="flex items-end gap-3.5 rounded-[11px] border border-w070 bg-k220 px-5 pb-3.5 pt-4">
      <div className="mb-[30px] flex h-[74px] flex-col items-end justify-between text-[9.5px] font-medium tracking-[0.02em] text-t7">
        <span>+12 dB</span>
        <span>+6 dB</span>
        <span>0 dB</span>
        <span>−6 dB</span>
        <span>−12 dB</span>
      </div>
      <div className="relative flex flex-1 items-end">
        {/* Grid behind the bands: the centre line reads a step brighter,
            so 0 dB is findable without counting. */}
        <svg
          viewBox="0 0 100 88"
          preserveAspectRatio="none"
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 h-[88px] w-full overflow-visible"
        >
          {[7, 25.5, 44, 62.5, 81].map((y) => (
            <line
              key={y}
              x1="0"
              y1={y}
              x2="100"
              y2={y}
              stroke={y === 44 ? "var(--w120)" : "var(--w055)"}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {EQ_BANDS.map((hz, i) => (
          <EqBand key={hz} index={i} hz={hz} gain={gains[i] ?? 0} />
        ))}
      </div>
    </div>
  );
}

function EqBand({
  index,
  hz,
  gain,
}: {
  index: number;
  hz: number;
  gain: number;
}) {
  const setBandGain = usePlaybackSettings((s) => s.setBandGain);
  const trackRef = useRef<HTMLDivElement>(null);

  // Top of the knob for a gain, mirroring the design's own arithmetic:
  // 0 dB centres it on the middle grid line and ±12 dB reaches the outer
  // ones, which sit 37px away.
  const top = 44 - (gain / EQ_RANGE) * 37 - KNOB / 2;

  const gainAt = useCallback((clientY: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const centre = r.top + 44;
    return Math.round(((centre - clientY) / 37) * EQ_RANGE);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setBandGain(index, gainAt(e.clientY));
  };

  const label = hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`;

  return (
    <div className="flex flex-1 flex-col items-center gap-2.5">
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={`${label} band`}
        aria-valuemin={-EQ_RANGE}
        aria-valuemax={EQ_RANGE}
        aria-valuenow={gain}
        aria-valuetext={`${gain > 0 ? "+" : ""}${gain} dB`}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            setBandGain(index, gainAt(e.clientY));
          }
        }}
        onKeyDown={(e) => {
          const step =
            e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : null;
          if (step === null) return;
          e.preventDefault();
          setBandGain(index, gain + step);
        }}
        style={{ height: TRACK_H }}
        className="relative w-[7px] cursor-pointer touch-none rounded-[4px] bg-surf6 shadow-[inset_0_1px_2px_var(--k550),0_0_0_1px_var(--w045)] outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span
          aria-hidden
          className="absolute -left-[3.5px] size-3.5 rounded-full shadow-[0_1px_3px_var(--k600),inset_0_1px_1px_var(--w350)] transition-[top] duration-[180ms]"
          style={{
            top,
            background:
              "radial-gradient(circle at 50% 35%, var(--acc2), var(--active) 70%)",
          }}
        />
      </div>
      <span className="whitespace-nowrap font-mono text-[9.5px] font-medium tracking-[0.02em] text-t5">
        {label}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Output device                                                       */
/* ------------------------------------------------------------------ */

/** Only devices Chromium lets us name (and therefore select). */
function listOutputs(all: MediaDeviceInfo[]): MediaDeviceInfo[] {
  return all.filter(
    (d) =>
      d.kind === "audiooutput" &&
      d.label &&
      d.deviceId &&
      d.deviceId !== "default",
  );
}

function OutputDeviceRow() {
  const deviceId = usePlaybackSettings((s) => s.outputDeviceId);
  const setDeviceId = usePlaybackSettings((s) => s.setOutputDeviceId);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const unlockedRef = useRef(false);

  // Chromium only names output devices (and only lets `setSinkId` pick
  // one) once the page has been granted media capture, so the list is
  // empty until `unlockLabels` below has run. It refreshes when
  // something is plugged in or unplugged.
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return;
    const load = () => {
      void md
        .enumerateDevices()
        .then((all) => setDevices(listOutputs(all)))
        .catch(() => setDevices([]));
    };
    load();
    md.addEventListener("devicechange", load);
    return () => md.removeEventListener("devicechange", load);
  }, []);

  // Opening the menu with nothing to show asks for a (silent, instantly
  // released) microphone stream: that grant is what unlocks the names.
  // On Windows the Rust side answers the request for our own pages
  // (src-tauri/src/webview_permissions.rs), so no dialog appears.
  const unlockLabels = async () => {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia || unlockedRef.current || devices.length) return;
    unlockedRef.current = true;
    try {
      const stream = await md.getUserMedia({ audio: true });
      for (const t of stream.getTracks()) t.stop();
      setDevices(listOutputs(await md.enumerateDevices()));
    } catch {
      unlockedRef.current = false;
    }
  };

  const current = devices.find((d) => d.deviceId === deviceId);
  const t = useT();
  const label = current?.label ?? t("settings.playback.systemDefault");

  return (
    <SettingRow
      icon={IconHeadphonesFilled}
      settingId="output-device"
      title={t("settings.playback.outputDevice")}
      description={t("settings.playback.outputDeviceDesc")}
      control={
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) void unlockLabels();
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 w-[232px] cursor-pointer items-center gap-2 rounded-[10px] border border-w070 bg-w050 px-2.5 text-[13px] text-t2 transition-colors duration-[140ms] hover:bg-w070"
            >
              <IconHeadphonesFilled className="size-3.5 shrink-0 text-t5" />
              <span className="min-w-0 flex-1 truncate text-left">{label}</span>
              <IconChevronDown className="size-3 shrink-0 text-t6" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[232px]">
            <DropdownMenuItem onSelect={() => setDeviceId("")}>
              <span className="flex-1 truncate">
                {t("settings.playback.systemDefault")}
              </span>
              {deviceId === "" ? (
                <IconCheck className="size-4 text-active!" stroke={2.4} />
              ) : null}
            </DropdownMenuItem>
            {devices.map((d) => (
              <DropdownMenuItem
                key={d.deviceId}
                onSelect={() => setDeviceId(d.deviceId)}
              >
                <span className="flex-1 truncate">{d.label}</span>
                {deviceId === d.deviceId ? (
                  <IconCheck className="size-4 text-active!" stroke={2.4} />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  );
}

/* ------------------------------------------------------------------ */
/* Back button                                                         */
/* ------------------------------------------------------------------ */

const BACK_OPTIONS: { value: BackButtonMode; labelKey: string }[] = [
  { value: "previous", labelKey: "settings.playback.backPrevious" },
  { value: "restart", labelKey: "settings.playback.backRestart" },
  { value: "smart", labelKey: "settings.playback.backSmart" },
];

function BackButtonGroup() {
  const t = useT();
  const mode = usePlaybackSettings((s) => s.backButton);
  const setMode = usePlaybackSettings((s) => s.setBackButton);
  const seconds = usePlaybackSettings((s) => s.smartBackSeconds);
  const setSeconds = usePlaybackSettings((s) => s.setSmartBackSeconds);

  return (
    <Group>
      <div className="flex flex-col">
        <SettingRow
          icon={IconPlayerSkipBackFilled}
          settingId="back-button"
          title={t("settings.playback.backButton")}
          description={t("settings.playback.backButtonDesc")}
          control={
            <SegmentedControl
              value={mode}
              onChange={setMode}
              options={BACK_OPTIONS.map((o) => ({
                value: o.value,
                label: t(o.labelKey),
              }))}
            />
          }
        />
        {mode === "smart" ? (
          <div className="flex items-center justify-between gap-6 pb-4">
            <span className="text-[12.5px] text-t6">
              {t("settings.playback.smartBackHint")}
            </span>
            <SegmentedControl
              value={String(seconds)}
              onChange={(v) => setSeconds(Number(v))}
              options={[
                { value: "2", label: "2 s" },
                { value: "3", label: "3 s" },
                { value: "5", label: "5 s" },
              ]}
            />
          </div>
        ) : null}
      </div>
    </Group>
  );
}
