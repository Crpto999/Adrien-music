import { IconStack2 } from "@tabler/icons-react";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { ProviderPriorityList } from "@/components/settings/provider-priority";
import { useT } from "@/lib/i18n";

/**
 * The Sources tab: the multi-source audio backend's controls.
 *
 * It holds one thing — the order the providers are tried in. The
 * third-party unblock pool behind the NetEase source is a
 * self-managing pool: it probes itself, retires its own dead
 * endpoints, and needs nothing from the user, so it has no business
 * on a settings screen.
 */
export function SourcesTab() {
  const t = useT();
  return (
    <TabPane>
      <Group>
        <SettingRow
          icon={IconStack2}
          settingId="provider-priority"
          title={t("settings.providers.priority")}
          description={t("settings.providers.priorityDesc")}
          control={null}
        />
      </Group>
      <ProviderPriorityList />
    </TabPane>
  );
}
