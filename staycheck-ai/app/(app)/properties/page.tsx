"use client";

import { useEffect, useState } from "react";
import { PageHeader, PAGE_CONTAINER_CLASS } from "@/app/components/PageHeader";
import { CompanyRuleSet, PropertyRuleSet } from "@/app/rules/types";

/**
 * 物件管理画面。
 * - 会社の一覧表示・新規登録・削除
 * - 選択した会社に属する物件の一覧表示・新規登録・編集・削除
 *
 * ここで登録した内容は、「チェック」画面の「物件固有ルール(任意)」から選択でき、
 * 選択しなければこれまで通り標準基準のみで判定される
 * (この画面自体は判定ロジックには一切関与しない)。
 */
export default function PropertiesPage() {
  const [companies, setCompanies] = useState<CompanyRuleSet[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(true);
  const [companiesError, setCompaniesError] = useState<string | null>(null);

  const [newCompanyId, setNewCompanyId] = useState("");
  const [newCompanyLabel, setNewCompanyLabel] = useState("");
  const [companySubmitting, setCompanySubmitting] = useState(false);

  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);

  const [properties, setProperties] = useState<PropertyRuleSet[]>([]);
  const [propertiesLoading, setPropertiesLoading] = useState(false);
  const [propertiesError, setPropertiesError] = useState<string | null>(null);

  const [editingPropertyId, setEditingPropertyId] = useState<string | null>(null);
  const [propertyIdInput, setPropertyIdInput] = useState("");
  const [propertyLabelInput, setPropertyLabelInput] = useState("");
  const [ruleTextInput, setRuleTextInput] = useState("");
  const [propertySubmitting, setPropertySubmitting] = useState(false);
  const [propertyFormError, setPropertyFormError] = useState<string | null>(null);

  const fetchCompanies = async () => {
    setCompaniesLoading(true);
    setCompaniesError(null);
    try {
      const res = await fetch("/api/companies");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "会社一覧の取得に失敗しました。");
      setCompanies(data.companies ?? []);
    } catch (err) {
      setCompaniesError(err instanceof Error ? err.message : "会社一覧の取得に失敗しました。");
    } finally {
      setCompaniesLoading(false);
    }
  };

  useEffect(() => {
    fetchCompanies();
  }, []);

  const fetchProperties = async (companyId: string) => {
    setPropertiesLoading(true);
    setPropertiesError(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/properties`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "物件一覧の取得に失敗しました。");
      setProperties(data.properties ?? []);
    } catch (err) {
      setPropertiesError(err instanceof Error ? err.message : "物件一覧の取得に失敗しました。");
    } finally {
      setPropertiesLoading(false);
    }
  };

  const resetPropertyForm = () => {
    setEditingPropertyId(null);
    setPropertyIdInput("");
    setPropertyLabelInput("");
    setRuleTextInput("");
    setPropertyFormError(null);
  };

  const selectCompany = (companyId: string) => {
    setSelectedCompanyId(companyId);
    resetPropertyForm();
    fetchProperties(companyId);
  };

  const handleCreateCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    setCompanySubmitting(true);
    setCompaniesError(null);
    try {
      const res = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: newCompanyId.trim(), companyLabel: newCompanyLabel.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "会社の登録に失敗しました。");
      setNewCompanyId("");
      setNewCompanyLabel("");
      await fetchCompanies();
    } catch (err) {
      setCompaniesError(err instanceof Error ? err.message : "会社の登録に失敗しました。");
    } finally {
      setCompanySubmitting(false);
    }
  };

  const handleDeleteCompany = async (companyId: string) => {
    if (!confirm(`会社「${companyId}」を削除します。所属する物件もすべて削除されます。よろしいですか?`)) return;
    try {
      const res = await fetch(`/api/companies/${companyId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "会社の削除に失敗しました。");
      if (selectedCompanyId === companyId) {
        setSelectedCompanyId(null);
        setProperties([]);
      }
      await fetchCompanies();
    } catch (err) {
      setCompaniesError(err instanceof Error ? err.message : "会社の削除に失敗しました。");
    }
  };

  const startEditProperty = (property: PropertyRuleSet) => {
    setEditingPropertyId(property.propertyId);
    setPropertyIdInput(property.propertyId);
    setPropertyLabelInput(property.propertyLabel);
    setRuleTextInput(property.ruleText);
    setPropertyFormError(null);
  };

  const handleSubmitProperty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCompanyId) return;
    setPropertySubmitting(true);
    setPropertyFormError(null);
    try {
      if (editingPropertyId) {
        const res = await fetch(`/api/companies/${selectedCompanyId}/properties/${editingPropertyId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ propertyLabel: propertyLabelInput.trim(), ruleText: ruleTextInput }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "物件の更新に失敗しました。");
      } else {
        const res = await fetch(`/api/companies/${selectedCompanyId}/properties`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            propertyId: propertyIdInput.trim(),
            propertyLabel: propertyLabelInput.trim(),
            ruleText: ruleTextInput,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "物件の登録に失敗しました。");
      }
      resetPropertyForm();
      await fetchProperties(selectedCompanyId);
    } catch (err) {
      setPropertyFormError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setPropertySubmitting(false);
    }
  };

  const handleDeleteProperty = async (propertyId: string) => {
    if (!selectedCompanyId) return;
    if (!confirm(`物件「${propertyId}」を削除します。よろしいですか?`)) return;
    try {
      const res = await fetch(`/api/companies/${selectedCompanyId}/properties/${propertyId}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "物件の削除に失敗しました。");
      if (editingPropertyId === propertyId) resetPropertyForm();
      await fetchProperties(selectedCompanyId);
    } catch (err) {
      setPropertiesError(err instanceof Error ? err.message : "物件の削除に失敗しました。");
    }
  };

  const inputClass =
    "rounded-lg border border-hairline bg-mist px-3 py-2 text-sm text-ink outline-none focus:border-teal";
  const primaryButtonClass =
    "rounded-lg bg-ink px-4 py-2 font-display text-sm font-bold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-30 enabled:hover:opacity-90";

  return (
    <main className={PAGE_CONTAINER_CLASS}>
      <PageHeader
        title="物件管理"
        description="ここで登録した会社・物件は、チェック画面の「物件固有ルール(任意)」から選べます。何も選ばなければ、標準基準のみで判定します。"
      />

      <section className="mt-6 rounded-2xl border border-hairline bg-surface p-6 shadow-card">
        <h2 className="font-display text-sm font-bold tracking-wide text-ink">01 / 会社を選択・登録</h2>

        {companiesError && <p className="mt-3 text-sm text-terracotta">{companiesError}</p>}

        {companiesLoading ? (
          <p className="mt-4 text-sm text-inkfaint">読み込み中…</p>
        ) : companies.length === 0 ? (
          <p className="mt-4 text-sm text-inkfaint">まだ会社が登録されていません。</p>
        ) : (
          <div className="mt-4 space-y-2">
            {companies.map((c) => (
              <div
                key={c.companyId}
                className={`flex items-center justify-between rounded-lg border px-3 py-2.5 ${
                  selectedCompanyId === c.companyId ? "border-teal bg-teal-soft" : "border-hairline"
                }`}
              >
                <button onClick={() => selectCompany(c.companyId)} className="flex-1 text-left">
                  <span className="font-medium text-ink">{c.companyLabel}</span>
                  <span className="ml-2 font-mono text-xs text-inkfaint">{c.companyId}</span>
                </button>
                <button
                  onClick={() => handleDeleteCompany(c.companyId)}
                  className="ml-3 text-xs text-inkfaint underline decoration-dotted hover:text-terracotta"
                >
                  削除
                </button>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handleCreateCompany} className="mt-5 border-t border-hairline pt-5">
          <p className="text-xs font-medium text-inkfaint">新しい会社を登録</p>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              type="text"
              value={newCompanyId}
              onChange={(e) => setNewCompanyId(e.target.value)}
              placeholder="会社ID(例: sample-co)"
              className={inputClass}
            />
            <input
              type="text"
              value={newCompanyLabel}
              onChange={(e) => setNewCompanyLabel(e.target.value)}
              placeholder="会社名(表示用)"
              className={inputClass}
            />
          </div>
          <button
            type="submit"
            disabled={companySubmitting || !newCompanyId.trim() || !newCompanyLabel.trim()}
            className={`mt-3 ${primaryButtonClass}`}
          >
            {companySubmitting ? "登録中…" : "会社を登録"}
          </button>
        </form>
      </section>

      {selectedCompanyId && (
        <section className="mt-6 rounded-2xl border border-hairline bg-surface p-6 shadow-card">
          <h2 className="font-display text-sm font-bold tracking-wide text-ink">02 / 物件を登録・編集</h2>
          <p className="mt-1 text-xs text-inkfaint">
            選択中の会社: <span className="font-medium text-ink">{selectedCompanyId}</span>
          </p>

          {propertiesError && <p className="mt-3 text-sm text-terracotta">{propertiesError}</p>}

          {propertiesLoading ? (
            <p className="mt-4 text-sm text-inkfaint">読み込み中…</p>
          ) : properties.length === 0 ? (
            <p className="mt-4 text-sm text-inkfaint">まだ物件が登録されていません。</p>
          ) : (
            <div className="mt-4 space-y-2">
              {properties.map((p) => (
                <div
                  key={p.propertyId}
                  className={`flex items-center justify-between rounded-lg border px-3 py-2.5 ${
                    editingPropertyId === p.propertyId ? "border-teal bg-teal-soft" : "border-hairline"
                  }`}
                >
                  <button onClick={() => startEditProperty(p)} className="flex-1 text-left">
                    <span className="font-medium text-ink">{p.propertyLabel}</span>
                    <span className="ml-2 font-mono text-xs text-inkfaint">{p.propertyId}</span>
                  </button>
                  <button
                    onClick={() => handleDeleteProperty(p.propertyId)}
                    className="ml-3 text-xs text-inkfaint underline decoration-dotted hover:text-terracotta"
                  >
                    削除
                  </button>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={handleSubmitProperty} className="mt-5 border-t border-hairline pt-5">
            <p className="text-xs font-medium text-inkfaint">
              {editingPropertyId ? `物件を編集(${editingPropertyId})` : "新しい物件を登録"}
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                type="text"
                value={propertyIdInput}
                onChange={(e) => setPropertyIdInput(e.target.value)}
                placeholder="物件ID(例: room-101)"
                disabled={!!editingPropertyId}
                className={`${inputClass} disabled:opacity-50`}
              />
              <input
                type="text"
                value={propertyLabelInput}
                onChange={(e) => setPropertyLabelInput(e.target.value)}
                placeholder="物件名(表示用)"
                className={inputClass}
              />
            </div>
            <textarea
              value={ruleTextInput}
              onChange={(e) => setRuleTextInput(e.target.value)}
              placeholder="物件固有ルール(任意・自由記述。例: 鍵は3本、予備布団は押入れ上段に2組)"
              rows={4}
              className={`mt-2 w-full ${inputClass}`}
            />
            {propertyFormError && <p className="mt-2 text-sm text-terracotta">{propertyFormError}</p>}
            <div className="mt-3 flex gap-2">
              <button
                type="submit"
                disabled={
                  propertySubmitting ||
                  !propertyLabelInput.trim() ||
                  (!editingPropertyId && !propertyIdInput.trim())
                }
                className={primaryButtonClass}
              >
                {propertySubmitting ? "保存中…" : editingPropertyId ? "更新する" : "物件を登録"}
              </button>
              {editingPropertyId && (
                <button
                  type="button"
                  onClick={resetPropertyForm}
                  className="rounded-lg border border-hairline px-4 py-2 text-sm text-inkfaint hover:text-ink"
                >
                  キャンセル
                </button>
              )}
            </div>
          </form>
        </section>
      )}
    </main>
  );
}
