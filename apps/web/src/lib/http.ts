export async function parseApiResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: (T & { error?: string }) | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as T & { error?: string };
    } catch {
      if (response.ok) throw new Error("A API retornou uma resposta inválida.");
    }
  }
  if (!response.ok) {
    throw new Error(body?.error ?? `API indisponível (HTTP ${response.status})`);
  }
  if (!body) throw new Error("A API retornou uma resposta vazia.");
  return body;
}
