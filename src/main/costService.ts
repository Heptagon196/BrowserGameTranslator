import { AiBalanceSnapshot, ProviderConfig } from "../shared/types";
import { networkFetch } from "./networkProxyService";

export async function loadProviderBalance(provider: ProviderConfig): Promise<AiBalanceSnapshot> {
  if (provider.type !== "deepseek") {
    return {
      providerId: provider.id,
      isAvailable: false,
      balances: [],
      error: "当前供应商没有可用的余额查询接口。OpenAI 的官方 Costs API 通常需要组织 Admin Key。"
    };
  }
  if (!provider.apiKey.trim()) {
    return { providerId: provider.id, isAvailable: false, balances: [], error: "请先填写 DeepSeek API Key。" };
  }
  const baseUrl = provider.baseUrl.replace(/\/$/, "");
  const response = await networkFetch(`${baseUrl}/user/balance`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${provider.apiKey}`
    }
  });
  if (!response.ok) {
    const body = await response.text();
    return { providerId: provider.id, isAvailable: false, balances: [], error: `余额查询失败：${response.status} ${body.slice(0, 300)}` };
  }
  const data = (await response.json()) as {
    is_available?: boolean;
    balance_infos?: Array<{
      currency?: string;
      total_balance?: string;
      granted_balance?: string;
      topped_up_balance?: string;
    }>;
  };
  return {
    providerId: provider.id,
    isAvailable: Boolean(data.is_available),
    balances: (data.balance_infos ?? []).map((entry) => ({
      currency: entry.currency === "USD" ? "USD" : "CNY",
      totalBalance: String(entry.total_balance ?? "0"),
      grantedBalance: String(entry.granted_balance ?? "0"),
      toppedUpBalance: String(entry.topped_up_balance ?? "0")
    }))
  };
}
