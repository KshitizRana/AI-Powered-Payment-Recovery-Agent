import axios from "axios";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/api/v1";
console.log(API)

export async function fetcher<T>(url: string): Promise<T> {
    const res = await axios.get<T>(url);
    return res.data;
}

export const endpoints = {
    metrics: `${API}/recovery/metrics`,
    list: (page = 1, status?: string, type?: string) => {
        const params = new URLSearchParams({ page: String(page), limit: "20" });
        if (status) params.set("status", status);
        if (type) params.set("type", type);
        return `${API}/recovery/list?${params}`;
    },
    detail: (id: string) => `${API}/recovery/${id}`,
    simulate: `${API}/simulate`,
};