import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppgenPageDto, AppgenStakeDto } from "@appgen/shared";
import { api } from "../../api/client.js";
import { keys } from "../../api/queries.js";

export const appgenKey = ["appgen"] as const;

export const useAppgen = () =>
  useQuery({
    queryKey: appgenKey,
    queryFn: ({ signal }) => api.get<AppgenPageDto>("/v1/appgen", signal),
    refetchInterval: 30_000,
  });

const useRefresh = () => {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: appgenKey });
    void qc.invalidateQueries({ queryKey: keys.me });
  };
};

export const useStakeAppgen = () => {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (body: { appId: string; amount: number }) => api.post<AppgenStakeDto>("/v1/appgen/stake", body), onSuccess: refresh });
};

export const useUnstakeAppgen = () => {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (stakeId: string) => api.post<AppgenStakeDto>("/v1/appgen/unstake", { stakeId }), onSuccess: refresh });
};

export const useClaimStaker = () => {
  const refresh = useRefresh();
  return useMutation({ mutationFn: () => api.post<{ usdMicros: string; wei: string; txHash: string }>("/v1/appgen/claim", {}), onSuccess: refresh });
};
