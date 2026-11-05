import React, { useId } from 'react';

export interface FieldProps {
  id?: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactElement | ((props: { id: string }) => React.ReactNode);
  className?: string;
  labelClassName?: string;
  descriptionClassName?: string;
}

export const Field: React.FC<FieldProps> = ({
  id,
  label,
  description,
  error,
  badge,
  children,
  className = '',
  labelClassName = '',
  descriptionClassName = '',
}) => {
  const generatedId = useId();
  const controlId = id || (React.isValidElement(children) && (children.props as any).id) || generatedId;

  return (
    <div className={`space-y-1 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={controlId}
          className={`block text-xs font-medium text-[var(--t-text)] ${labelClassName}`}
        >
          {label}
        </label>
        {badge}
      </div>
      {description && (
        <p className={`text-xs text-[var(--t-text-3)] ${descriptionClassName}`}>
          {description}
        </p>
      )}
      {typeof children === 'function'
        ? children({ id: controlId })
        : React.isValidElement(children)
          ? React.cloneElement(children as React.ReactElement<any>, {
              id: (children as React.ReactElement<any>).props.id || controlId,
            })
          : children}
      {error && (
        <p className="text-xs text-[var(--t-crit)]">{error}</p>
      )}
    </div>
  );
};

Field.displayName = 'Field';
