import SwiftUI
import Observation

@MainActor
@Observable
final class SignInViewModel {
    enum Method: String, CaseIterable, Identifiable {
        case email = "Email", mobile = "Mobile"
        var id: String { rawValue }
    }

    enum EmailMode { case signIn, signUp }

    var method: Method = .email
    var emailMode: EmailMode = .signIn

    var fullName = ""
    var email = ""
    var password = ""
    var phone = ""
    var code = ""
    private(set) var codeSent = false

    private(set) var isWorking = false
    private(set) var formError: String?
    private(set) var fieldErrors: [String: String] = [:]

    private let auth: AuthStore

    init(auth: AuthStore) { self.auth = auth }

    // Client checks are only those a request needs to be well-formed; the server decides the rest
    // (password strength, reserved addresses, phone normalisation) and its messages are shown.
    var canSubmit: Bool {
        guard !isWorking else { return false }
        switch method {
        case .email:
            let base = Self.looksLikeEmail(email) && !password.isEmpty
            return emailMode == .signIn ? base : base && fullName.trimmingCharacters(in: .whitespaces).count >= 2
        case .mobile:
            return codeSent ? code.count == 6 && code.allSatisfy(\.isNumber) : Self.looksLikePhone(phone)
        }
    }

    func submit() async {
        await run {
            switch method {
            case .email where emailMode == .signIn:
                try await auth.login(email: email, password: password)
            case .email:
                try await auth.register(RegistrationForm(fullName: fullName, email: email, password: password))
            case .mobile where !codeSent:
                try await auth.requestPhoneCode(phone: phone)
                codeSent = true
            case .mobile:
                try await auth.verifyPhoneCode(phone: phone, code: code, fullName: nil)
            }
        }
        if fieldErrors.isEmpty, formError == nil { password = "" }
    }

    func changeNumber() {
        codeSent = false
        code = ""
        formError = nil
    }

    func error(for field: String) -> String? { fieldErrors[field] }

    private func run(_ action: () async throws -> Void) async {
        isWorking = true
        formError = nil
        fieldErrors = [:]
        defer { isWorking = false }
        do {
            try await action()
        } catch let error as AuthError {
            formError = error.userMessage
        } catch let APIError.server(_, _, message, fields) where !fields.isEmpty {
            fieldErrors = fields.compactMapValues(\.first)
            if fieldErrors.keys.allSatisfy({ !["email", "password", "fullName", "phone", "code"].contains($0) }) {
                formError = message
            }
        } catch {
            formError = error.userMessage
        }
    }

    static func looksLikeEmail(_ value: String) -> Bool {
        let parts = value.trimmingCharacters(in: .whitespaces).split(separator: "@")
        return parts.count == 2 && parts[1].contains(".") && !parts[0].isEmpty
    }

    /// The API refuses a bare national number (it cannot tell India from the US), so the
    /// country code is required: "+" then 6–19 digits.
    static func looksLikePhone(_ value: String) -> Bool {
        let compact = value.filter { !$0.isWhitespace && $0 != "-" }
        return compact.first == "+" && (7...20).contains(compact.count) && compact.dropFirst().allSatisfy(\.isNumber)
    }
}

struct SignInView: View {
    @Environment(AppContainer.self) private var container
    @Environment(\.dismiss) private var dismiss
    @State private var model: SignInViewModel?
    @FocusState private var focus: Field?

    private enum Field: Hashable { case name, email, password, phone, code }

    var body: some View {
        NavigationStack {
            Group {
                if let model { form(model) }
            }
            .scrollContentBackground(.hidden)
            .etgScreenBackground()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .task {
            if model == nil { model = SignInViewModel(auth: container.auth) }
        }
    }

    private var title: String {
        guard let model else { return "Sign in" }
        return model.method == .email && model.emailMode == .signUp ? "Create account" : "Sign in"
    }

    private func form(_ model: SignInViewModel) -> some View {
        @Bindable var model = model
        return Form {
            Section {
                BrandMark().frame(maxWidth: .infinity, alignment: .leading)
                Picker("Sign in with", selection: $model.method) {
                    ForEach(SignInViewModel.Method.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())

            switch model.method {
            case .email: emailFields(model)
            case .mobile: mobileFields(model)
            }

            if let error = model.formError {
                Section {
                    Label(error, systemImage: "exclamationmark.circle")
                        .foregroundStyle(ETGColor.critical)
                        .font(ETGFont.subheadline)
                        .accessibilityAddTraits(.isStaticText)
                }
            }

            Section {
                Button {
                    Task { await model.submit() }
                } label: {
                    HStack(spacing: ETGSpace.sm) {
                        if model.isWorking { ProgressView().tint(ETGColor.onAction) }
                        Text(submitTitle(model))
                    }
                }
                .buttonStyle(.etgPrimary)
                .disabled(!model.canSubmit)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())

                if model.method == .email {
                    Button(model.emailMode == .signIn ? "New here? Create an account" : "Have an account? Sign in") {
                        model.emailMode = model.emailMode == .signIn ? .signUp : .signIn
                    }
                    .font(ETGFont.subheadline.weight(.semibold))
                    .foregroundStyle(ETGColor.ink)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
            }

            if container.configuration.environment == .mock {
                Section("Sample data") {
                    Text("Email \(MockAuthService.demoEmail), password \(MockAuthService.demoPassword). Mobile code \(MockAuthService.demoOTP).")
                        .font(ETGFont.caption)
                        .foregroundStyle(ETGColor.muted)
                        .textSelection(.enabled)
                }
            }
        }
    }

    @ViewBuilder
    private func emailFields(_ model: SignInViewModel) -> some View {
        @Bindable var model = model
        Section {
            if model.emailMode == .signUp {
                field("Full name", error: model.error(for: "fullName")) {
                    TextField("Full name", text: $model.fullName)
                        .textContentType(.name)
                        .submitLabel(.next)
                        .focused($focus, equals: .name)
                        .onSubmit { focus = .email }
                }
            }
            field("Email", error: model.error(for: "email")) {
                // An explicit prompt: a bare email placeholder is styled as a link.
                TextField("Email", text: $model.email, prompt: Text(verbatim: "you@example.com").foregroundStyle(ETGColor.muted))
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($focus, equals: .email)
                    .onSubmit { focus = .password }
            }
            field("Password", error: model.error(for: "password")) {
                SecureField(model.emailMode == .signUp ? "At least 10 characters" : "Password", text: $model.password)
                    .textContentType(model.emailMode == .signUp ? .newPassword : .password)
                    .submitLabel(.go)
                    .focused($focus, equals: .password)
                    .onSubmit { if model.canSubmit { Task { await model.submit() } } }
            }
        }
    }

    @ViewBuilder
    private func mobileFields(_ model: SignInViewModel) -> some View {
        @Bindable var model = model
        Section {
            field("Mobile number", error: model.error(for: "phone")) {
                TextField("Mobile number", text: $model.phone, prompt: Text(verbatim: "+91 98765 43210").foregroundStyle(ETGColor.muted))
                    .textContentType(.telephoneNumber)
                    .keyboardType(.phonePad)
                    .disabled(model.codeSent)
                    .focused($focus, equals: .phone)
            }
            if model.codeSent {
                field("6-digit code", error: model.error(for: "code")) {
                    TextField("123456", text: $model.code)
                        .textContentType(.oneTimeCode)
                        .keyboardType(.numberPad)
                        .focused($focus, equals: .code)
                }
                Button("Use a different number") { model.changeNumber() }
                    .font(ETGFont.subheadline)
                    .foregroundStyle(ETGColor.ink)
            }
        } footer: {
            Text(model.codeSent
                 ? "We sent a code to \(model.phone). It can take a minute to arrive."
                 : "Include your country code. We'll text you a sign-in code; standard rates may apply.")
        }
    }

    private func field<Content: View>(_ label: String, error: String?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: ETGSpace.xs) {
            Text(label).font(ETGFont.caption.weight(.semibold)).foregroundStyle(ETGColor.muted)
            content()
                .font(ETGFont.body)
                .accessibilityLabel(label)
                .accessibilityHint(error ?? "")
            if let error {
                Text(error).font(ETGFont.caption).foregroundStyle(ETGColor.critical)
            }
        }
        .padding(.vertical, 2)
    }

    private func submitTitle(_ model: SignInViewModel) -> String {
        switch model.method {
        case .email: return model.emailMode == .signIn ? "Sign in" : "Create account"
        case .mobile: return model.codeSent ? "Verify and sign in" : "Send code"
        }
    }
}

#Preview {
    SignInView()
        .environment(AppContainer.preview)
}
