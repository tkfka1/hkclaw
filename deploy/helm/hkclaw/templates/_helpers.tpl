{{- define "hkclaw.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "hkclaw.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "hkclaw.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "hkclaw.labels" -}}
helm.sh/chart: {{ include "hkclaw.chart" . }}
app.kubernetes.io/name: {{ include "hkclaw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "hkclaw.selectorLabels" -}}
app.kubernetes.io/name: {{ include "hkclaw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "hkclaw.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "hkclaw.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "hkclaw.persistenceClaimName" -}}
{{- if .Values.persistence.existingClaim -}}
{{- .Values.persistence.existingClaim -}}
{{- else -}}
{{- printf "%s-data" (include "hkclaw.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "hkclaw.serviceEnvSecretName" -}}
{{- if .Values.serviceEnv.existingSecret -}}
{{- .Values.serviceEnv.existingSecret -}}
{{- else -}}
{{- printf "%s-service-env" (include "hkclaw.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "hkclaw.adminSecretName" -}}
{{- if .Values.admin.existingSecret -}}
{{- .Values.admin.existingSecret -}}
{{- else -}}
{{- printf "%s-admin" (include "hkclaw.fullname" .) -}}
{{- end -}}
{{- end -}}
