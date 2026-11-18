import React, { useState, useEffect, useMemo } from 'react';
import { ArrowUp, ArrowDown, Trash2, Plus, GripVertical, AlertCircle } from 'lucide-react';
import { useLocale } from '../../context/LocaleContext';
import { SelectOrCustomInput, SelectOrCustomOption } from './SelectOrCustomInput';
import { validateModelSyntax } from '../../utils/models';

export interface SortableModelListProps {
  models: string[];
  onChange: (models: string[]) => void;
  availableOptions: (string | SelectOrCustomOption)[];
  unavailableModels?: Set<string> | string[];
  title?: string;
  hint?: string;
  infoTooltip?: React.ReactNode;
  dataTour?: string;
  dataTestId?: string;
  ariaLabel?: string;
  validate?: (val: string) => string | null;
}

export const SortableModelList: React.FC<SortableModelListProps> = ({
  models,
  onChange,
  availableOptions,
  unavailableModels,
  title,
  hint,
  infoTooltip,
  dataTour,
  dataTestId,
  ariaLabel,
  validate,
}) => {
  const { t } = useLocale();
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [modelToAdd, setModelToAdd] = useState<string>(() => {
    const first = availableOptions[0];
    return typeof first === 'string' ? first : first?.value || '';
  });

  useEffect(() => {
    if (!modelToAdd && availableOptions[0]) {
      const first = availableOptions[0];
      setModelToAdd(typeof first === 'string' ? first : first.value);
    }
  }, [availableOptions, modelToAdd]);

  const unavailableSet = useMemo(() => {
    if (unavailableModels instanceof Set) return unavailableModels;
    if (Array.isArray(unavailableModels)) return new Set(unavailableModels);
    const set = new Set<string>();
    for (const opt of availableOptions) {
      if (typeof opt !== 'string' && opt.available === false) {
        set.add(opt.value);
      }
    }
    return set;
  }, [unavailableModels, availableOptions]);

  const moveModel = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= models.length) return;
    if (target === 0 && unavailableSet.has(models[index])) return;
    const next = [...models];
    const temp = next[index];
    next[index] = next[target];
    next[target] = temp;
    onChange(next);
  };

  const removeModel = (index: number) => {
    onChange(models.filter((_, i) => i !== index));
  };

  const updateModel = (index: number, value: string) => {
    if (index === 0 && unavailableSet.has(value)) return;
    const next = [...models];
    next[index] = value;
    onChange(next);
  };

  const addModel = () => {
    const trimmed = modelToAdd.trim();
    if (!trimmed) return;
    if (unavailableSet.has(trimmed) && models.length === 0) return;
    onChange([...models, trimmed]);
  };

  const handleDragStart = (index: number) => {
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (index: number) => {
    if (draggedIndex === null || draggedIndex === index) return;
    if (index === 0 && unavailableSet.has(models[draggedIndex])) return;
    const next = [...models];
    const [moved] = next.splice(draggedIndex, 1);
    next.splice(index, 0, moved);
    onChange(next);
    setDraggedIndex(null);
  };

  return (
    <div data-tour={dataTour} data-testid={dataTestId} className="space-y-3">
      {title && (
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
            {title}
            {infoTooltip}
          </label>
          {hint && <p className="text-[11px] text-[var(--t-text-3)]">{hint}</p>}
        </div>
      )}

      {models.length === 0 && (
        <div className="p-3 rounded-lg border border-[var(--t-crit)] bg-[color-mix(in_srgb,var(--t-crit)_10%,transparent)] text-xs text-[var(--t-crit)] flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{t('settings.emptyChainWarning')}</span>
        </div>
      )}

      <div className="space-y-2" aria-label={ariaLabel || title}>
        {models.map((model, index) => {
          const itemError = validate ? validate(model) : validateModelSyntax(model, t);
          const isUnavailable = unavailableSet.has(model);
          return (
            <div
              key={`${model}-${index}`}
              draggable
              onDragStart={() => handleDragStart(index)}
              onDragOver={handleDragOver}
              onDrop={() => handleDrop(index)}
              className={`flex flex-col p-2.5 rounded-lg border gap-1.5 transition-colors ${
                isUnavailable
                  ? 'border-[var(--t-crit)] bg-[color-mix(in_srgb,var(--t-crit)_8%,transparent)]'
                  : 'border-[var(--t-border)] bg-[var(--t-surface-2)]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className="cursor-grab text-[var(--t-text-3)] hover:text-[var(--t-text)] shrink-0"
                  title="Drag to reorder"
                >
                  <GripVertical className="w-4 h-4" />
                </span>
                <span className="text-xs font-bold text-[var(--t-text-3)] w-5 shrink-0 text-center">
                  {index + 1}.
                </span>
                <div className="flex-1 min-w-0">
                  <SelectOrCustomInput
                    value={model}
                    onChange={(val) => updateModel(index, val)}
                    options={availableOptions}
                    validate={validate ? validate : (val) => validateModelSyntax(val, t)}
                    ariaLabel={`${ariaLabel || title || 'Model'} ${index + 1}`}
                    showCustomWarning={true}
                  />
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => moveModel(index, -1)}
                    disabled={index === 0}
                    title={t('settings.moveUp')}
                    aria-label={`${t('settings.moveUp')} (${model})`}
                    className="p-1 rounded hover:bg-[var(--t-hover)] text-[var(--t-text-3)] hover:text-[var(--t-text)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveModel(index, 1)}
                    disabled={index === models.length - 1}
                    title={t('settings.moveDown')}
                    aria-label={`${t('settings.moveDown')} (${model})`}
                    className="p-1 rounded hover:bg-[var(--t-hover)] text-[var(--t-text-3)] hover:text-[var(--t-text)] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeModel(index)}
                    title={t('settings.removeModel')}
                    aria-label={`${t('settings.removeModel')} (${model})`}
                    className="p-1 rounded hover:bg-[var(--t-hover)] text-[var(--t-crit)] hover:opacity-80 cursor-pointer ml-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {isUnavailable && (
                <div className="pl-9 text-xs text-[var(--t-crit)] flex items-center gap-1 font-medium" data-testid="model-unavailable-warning">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>{t('models.unavailableWarning')}</span>
                </div>
              )}
              {itemError && (
                <div className="pl-9 text-xs text-[var(--t-crit)] flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>{itemError}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="pt-2 border-t border-[var(--t-border)] flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[200px]">
          <SelectOrCustomInput
            value={modelToAdd}
            onChange={setModelToAdd}
            options={availableOptions}
            validate={validate ? validate : (val) => validateModelSyntax(val, t)}
            ariaLabel={t('settings.addModelToChain')}
            placeholder={t('settings.selectModelPlaceholder')}
            showCustomWarning={true}
          />
        </div>
        <button
          type="button"
          onClick={addModel}
          aria-label={t('settings.addModel')}
          className="px-3 py-2 rounded-lg bg-[var(--t-accent)] text-[var(--t-on-accent)] text-xs font-semibold inline-flex items-center gap-1.5 hover:bg-[var(--t-accent-hover)] cursor-pointer shrink-0 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{t('settings.addModel')}</span>
        </button>
      </div>
    </div>
  );
};
