package com.activetogether.companion.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.shape.RoundedCornerShape

// The web app's palette: signal red with a sunshine-yellow accent, on cool light greys.
val BrandRed = Color(0xFFD40511)
val BrandRedDeep = Color(0xFFB7040E)
val BrandYellow = Color(0xFFFFCC00)

private val Light = lightColorScheme(
    primary = BrandRed,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFDAD5),
    onPrimaryContainer = Color(0xFF410002),
    secondary = BrandYellow,
    onSecondary = Color(0xFF221B00),
    secondaryContainer = Color(0xFFFFF0B8),
    onSecondaryContainer = Color(0xFF221B00),
    tertiary = Color(0xFF1A7F37),
    background = Color(0xFFF5F6F8),
    onBackground = Color(0xFF171717),
    surface = Color.White,
    onSurface = Color(0xFF171717),
    surfaceVariant = Color(0xFFF0F1F4),
    onSurfaceVariant = Color(0xFF5E5E66),
    surfaceContainer = Color(0xFFF7F7F9),
    surfaceContainerLow = Color.White,
    surfaceContainerHigh = Color(0xFFEFEFF2),
    outline = Color(0xFFCBD0D6),
    outlineVariant = Color(0xFFE2E5E9),
    error = BrandRedDeep,
)

private val Dark = darkColorScheme(
    primary = Color(0xFFFF8A80),
    onPrimary = Color(0xFF5C0004),
    primaryContainer = Color(0xFF93000A),
    onPrimaryContainer = Color(0xFFFFDAD5),
    secondary = BrandYellow,
    onSecondary = Color(0xFF221B00),
    secondaryContainer = Color(0xFF574500),
    onSecondaryContainer = Color(0xFFFFF0B8),
    tertiary = Color(0xFF6FD08C),
    background = Color(0xFF111214),
    onBackground = Color(0xFFE6E6E9),
    surface = Color(0xFF1B1C1F),
    onSurface = Color(0xFFE6E6E9),
    surfaceVariant = Color(0xFF26272B),
    onSurfaceVariant = Color(0xFFB4B4BC),
    surfaceContainer = Color(0xFF1F2023),
    surfaceContainerLow = Color(0xFF1B1C1F),
    surfaceContainerHigh = Color(0xFF2A2B2F),
    outline = Color(0xFF45464C),
    outlineVariant = Color(0xFF34353A),
)

private val AppTypography = Typography().let { t ->
    t.copy(
        headlineMedium = t.headlineMedium.copy(fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.5).sp),
        headlineSmall = t.headlineSmall.copy(fontWeight = FontWeight.Bold),
        titleLarge = t.titleLarge.copy(fontWeight = FontWeight.Bold),
        titleMedium = t.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.4.sp),
    )
}

private val AppShapes = Shapes(
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp),
)

@Composable
fun ActiveTogetherTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) Dark else Light,
        typography = AppTypography,
        shapes = AppShapes,
        content = content,
    )
}
