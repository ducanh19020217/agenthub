import React, { useState, useEffect, useId, useMemo } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';
import { useLocale } from '../../context/LocaleContext';

export interface SelectOrCustomOption {
  value: string;
  label?: string;
  group?: string;
  available?: boolean;
  warning?: string | null;
}

export interface SelectOrCustomInputProps {
  value: string;
  onChange: (value: string) => void;
  options: (string | SelectOrCustomOption)[];
  placeholder?: string;
  customLabel?: string;
  validate?: (value: string) => string | null;
  id?: string;
  name?: string;
  ariaLabel?: string;
  className?: string;
  selectClassName?: string;
  inputClassName?: string;
  disabled?: boolean;
  required?: boolean;
  testId?: string;
  inputTestId?: string;
  allowEmpty?: boolean;
  emptyLabel?: string;
  customWarning?: string | null;
  showCustomWarning?: boolean;
}

export const SelectOrCustomInput: React.FC<SelectOrCustomInputProps> = ({
  value,
  onChange,
  options,
  placeholder,
  customLabel,
  validate,
  id,
  name,
  ariaLabel,
  className = '',
  selectClassName = '',
  inputClassName = '',
  disabled = false,
  testId,
  inputTestId,
  allowEmpty = false,
  emptyLabel = '—',
  customWarning,
  showCustomWarning,
}) => {
  const { t } = useLocale();
  const generatedId = useId();
  const inputId = id || generatedId;
  const errorId = `${inputId}-error`;

  const normalizedOptions: SelectOrCustomOption[] = useMemo(() => {
    return options.map((opt) =>
      typeof opt === 'string' ? { value: opt, label: opt } : opt,
    );
  }, [options]);

  const groupedOptions = useMemo(() => {
    const groups: { [group: string]: SelectOrCustomOption[] } = {};
    const ungrouped: SelectOrCustomOption[] = [];
    let hasGroups = false;
    for (const opt of normalizedOptions) {
      if (opt.group) {
        hasGroups = true;
        if (!groups[opt.group]) groups[opt.group] = [];
        groups[opt.group].push(opt);
      } else {
        ungrouped.push(opt);
      }
    }
    return { groups, ungrouped, hasGroups };
  }, [normalizedOptions]);

  const isKnownOption =
    normalizedOptions.some((opt) => opt.value === value) || (allowEmpty && value === '');

  // If value is unknown and non-empty, default to custom mode so user sees and can edit it
  const [isCustomMode, setIsCustomMode] = useState<boolean>(!isKnownOption && Boolean(value));
  const [touched, setTouched] = useState<boolean>(false);

  useEffect(() => {
    if (isKnownOption) {
      setIsCustomMode(false);
    } else if (Boolean(value)) {
      setIsCustomMode(true);
    }
  }, [value, isKnownOption]);

  const customText = customLabel || t('settings.customOption');
  const error = (isCustomMode || touched) && validate ? validate(value) : null;

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selected = e.target.value;
    if (selected === '__custom__') {
      setIsCustomMode(true);
      setTouched(true);
    } else {
      setIsCustomMode(false);
      setTouched(false);
      onChange(selected);
    }
  };

  const handleCustomInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTouched(true);
    onChange(e.target.value);
  };

  const handleBackToPresets = () => {
    setIsCustomMode(false);
    setTouched(false);
    if (normalizedOptions.length > 0) {
      onChange(normalizedOptions[0].value);
    } else if (allowEmpty) {
      onChange('');
    }
  };

  return (
    <div className={`space-y-1.5 ${className}`}>
      <select
        id={inputId}
        name={name}
        aria-label={ariaLabel}
        data-testid={testId}
        value={isCustomMode ? '__custom__' : value}
        onChange={handleSelectChange}
        disabled={disabled}
        className={`w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-hidden focus:ring-2 focus:ring-[var(--t-accent)] disabled:opacity-50 disabled:cursor-not-allowed ${selectClassName}`}
      >
        {allowEmpty && <option value="">{emptyLabel}</option>}
        {!allowEmpty && !value && !isCustomMode && (
          <option value="" disabled>
            {placeholder || '—'}
          </option>
        )}
        {groupedOptions.hasGroups ? (
          <>
            {groupedOptions.ungrouped.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label || opt.value}
              </option>
            ))}
            {Object.entries(groupedOptions.groups).map(([groupName, groupOpts]) => (
              <optgroup key={groupName} label={groupName}>
                {groupOpts.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label || opt.value}
                  </option>
                ))}
              </optgroup>
            ))}
          </>
        ) : (
          normalizedOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label || opt.value}
            </option>
          ))
        )}
        {!isKnownOption && Boolean(value) && !isCustomMode && (
          <option value={value}>{value} ({customText})</option>
        )}
        <option value="__custom__">{customText}</option>
      </select>

      {isCustomMode && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={value}
              onChange={handleCustomInputChange}
              placeholder={placeholder || t('settings.customInputPlaceholder')}
              aria-label={ariaLabel ? `${ariaLabel} (${customText})` : customText}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              data-testid={inputTestId || (testId ? `${testId}-custom-input` : undefined)}
              disabled={disabled}
              className={`flex-1 text-sm font-mono rounded-lg border px-3 py-1.5 bg-[var(--t-surface-2)] text-[var(--t-text)] focus:outline-hidden focus:ring-2 ${
                error
                  ? 'border-[var(--t-crit)] focus:ring-[var(--t-crit)]'
                  : 'border-[var(--t-border)] focus:ring-[var(--t-accent)]'
              } ${inputClassName}`}
            />
            {normalizedOptions.length > 0 && (
              <button
                type="button"
                onClick={handleBackToPresets}
                title={t('settings.backToPreset')}
                aria-label={t('settings.backToPreset')}
                className="p-2 rounded-lg border border-[var(--t-border)] hover:bg-[var(--t-hover)] text-[var(--t-text-3)] hover:text-[var(--t-text)] cursor-pointer transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            )}
          </div>
          {error ? (
            <p id={errorId} role="alert" className="text-xs text-[var(--t-crit)] flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </p>
          ) : (customWarning || (showCustomWarning && t('models.customWarning'))) && Boolean(value) ? (
            <p className="text-xs text-[var(--t-warn)] flex items-center gap-1" data-testid="custom-warning">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{customWarning || t('models.customWarning')}</span>
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
};
