"use client";

import useSWR from "swr";
import { fetcher, endpoints } from "./api";

export function useMetrics() {
    return useSWR(endpoints.metrics, fetcher<any>, {
        refreshInterval: 3000,
    });
}

export function useRecoveryList(page: number, status?: string, type?: string) {
    return useSWR(endpoints.list(page, status, type), fetcher<any>, {
        refreshInterval: 3000,
    });
}

export function useRecoveryDetail(id: string) {
    return useSWR(endpoints.detail(id), fetcher<any>, {
        refreshInterval: 2000,
    });
}